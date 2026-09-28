/**
 * learning/npc-talk — 伙伴对话：**接对话核**（有历史、有他自己的记忆），AI 优先、无 key 降级
 * （契约 `docs/NPC-PARTNER-SPEC.md` §4／§12）。
 *
 * ★★ 2026-09-28「原住民」那次改动把这里从**一次性无状态请求**改成了**会话**：
 *   旧实现每次只送「人设 + 本轮输入」，聊完即忘 —— 用户说过的话、他答过的承诺，下一句全没了。
 *   现在每位伙伴有一条属于自己的会话（`npc-session.ts`：伙伴 id 直接当 `sessions.id`），
 *   历史进 `messages`、长期记忆进 `sessions.summary`（滚动摘要），**且严格隔离**：
 *   不写全局 `user_memory`、不读全局画像 ⇒ A 伙伴不知道你跟 B 说过什么。
 *
 * ★★ 降级链照 `coach.ts` 的既有形状：`npc` 角色未绑定 ⇒ 回退 `explain`；连 model/apiKey 都没有 ⇒
 *   走 `NPC_FALLBACK_LINES`。**永不报错、永不空回**——伙伴是地图上的常驻元素，用户点他是
 *   "想跟伙伴说句话"，不是"提交一次模型调用"。
 * ★ 但降级必须可识别：响应体带 `source: 'ai' | 'fallback'`。**降级可以，假装没降级不行**。
 * ★ 降级的那句话**不落库**：罐头台词进了历史，下次就会被当成"他说过的话"喂回给模型，
 *   模型会顺着那个语气继续演 —— 一句兜底会污染整条会话。
 */
import { npcFallbackLine } from '@sb/shared';
import type { ChatMessage, ToolDefinition } from '../llm/types.js';
import { resolveNpcTarget } from './npc-genesis.js';
import { npcTradeInDomain, type NpcView } from './npc.js';
import type { ChestDraw } from './chest.js';
import { buildNpcMessages, ensureNpcSession, recordNpcTurn } from './npc-session.js';

/**
 * 伙伴手里唯一的工具：**送你一条没见过的新词**（`NPC-PARTNER-SPEC` §13）。
 *
 * ★★ 为什么交换要做成工具、而不是面板上的下拉框 + 按钮：
 *   交换在设定上是"跟这位邻居换点新花样"，那它就该发生在**对话里** ——
 *   用户说"有没有新东西教我"，他就掏一条出来。为一个纯参数（领域）让用户点三下下拉框，
 *   是把一次交流做成了一张表单。
 * ★ 领域**不让模型填**：它 = 伙伴此刻站的那一格，服务端说了算。
 *   让模型填领域，它就会编一个库里没有的领域名，然后交换必然失败且理由荒唐。
 *   ⇒ 工具**无参数**：模型只负责决定"该给了"，给什么由服务端定。
 */
const TRADE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'offer_new_term',
    description:
      '当用户想学点新的、或明确要你"换一条新词/教我点没见过的"时调用它。' +
      '你会得到一条这块地所属领域里、用户还没见过的新词条，然后用你自己的话把它介绍给他。' +
      '用户只是随口闲聊、或在问你已有词条的问题时，**不要**调它。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

/** 短对话上限（伙伴说不长的话）；温度比 coach 的 0.6 高——伙伴要有人味 */
const NPC_MAX_TOKENS = 600;
const NPC_TEMPERATURE = 0.8;

export interface NpcTalkResult {
  reply: string;
  /** ★ `fallback` 不是"失败了"，是"现在只能这样"——前端必须据此说实话 */
  source: 'ai' | 'fallback';
  /**
   * 这一轮他**真的**掏出了一条新词（模型调了 `offer_new_term` 且服务端换成了）。
   * 前端据此在气泡下面显示"收下"——走**既有** `POST /api/cards/chest/accept`，一字不改。
   */
  draw?: ChestDraw | null;
  /** 换不成时的那句人话（额度用完／这块地还没练熟）；★ 照实说，不假装没发生 */
  tradeNote?: string | null;
}

/**
 * 人设 = 他是谁 + **他此刻站在哪**（走位决定话题）+ 遇没遇险。
 *
 * ★★ `here` 与 `home` 分开说：伙伴会游走，他可能正站在别人的地上。
 *   两者相同 ⇒ "我这块地"；不同 ⇒ "我溜达到这儿了"。不分开说，他就会把脚下这块
 *   陌生词条说成"我守的"，与地图画面直接矛盾。
 */
function buildNpcPrompt(npc: NpcView, here: { term: string; domain: string } | null): string {
  const state = npc.threat
    ? `你现在正被「${npc.threat.term}」的怪堵着，很想有人来救你（用户答对那道题，怪就散了）。`
    : '你这会儿挺安好，附近没有怪。';
  const place =
    here && here.term !== npc.term
      ? `你这会儿溜达到了「${here.term}」（领域：${here.domain}）这块地上——**不是你自己那块**，是路过；聊它可以，但别说成是你守的。`
      : `你正待在自己那块地上（「${npc.term}」）。`;
  return [
    `你是知识大陆上的学习伙伴「${npc.name}」，家在「${npc.term}」（领域：${npc.domain}）这一块。${npc.bio}`,
    place,
    '用第一人称、口语化、简短（两三句就够），像一个住在那儿的邻居；不要列条目、不要用标题、不要用列表符号。',
    '你能做的是：陪用户聊脚下这块地的词条、用提问或线索帮他记牢它、在他路过时提一句这附近有没有怪。',
    '★ 你记得你们之前聊过什么（上文里有你自己的记忆摘要）——别每次都像第一次见面那样重新自我介绍。',
    '★ 不要编造用户的学习进度、复习数字、卡牌数量、欠账——那些由别的面板说，你说了就会和它们对不上。',
    state,
  ].join('\n');
}

/**
 * 生成伙伴回复，并把这一轮落进他自己的会话。
 *
 * `seed` 是降级台词的轮换种子（降级路径没有历史可依）。
 */
export async function npcTalk(opts: {
  ownerId: string | null;
  npc: NpcView;
  text: string;
  /** 他此刻站的那一格上的词条（由 `npcList().cells` 现查，调用方给） */
  here?: { term: string; domain: string } | null;
  seed?: number;
  signal?: AbortSignal;
}): Promise<NpcTalkResult> {
  const target = resolveNpcTarget(opts.ownerId);
  if (target?.model && target.apiKey) {
    const sessionId = ensureNpcSession(opts.npc.id, opts.ownerId, opts.npc.name, opts.npc.termId);
    const messages: ChatMessage[] = buildNpcMessages({
      systemPrompt: buildNpcPrompt(opts.npc, opts.here ?? null),
      sessionId,
      text: opts.text,
    });

    /** 跑一轮（可带工具）；返回正文与模型想调的工具 */
    const run = async (msgs: ChatMessage[], withTool: boolean) => {
      let acc = '';
      let calls: { id: string; name: string; arguments: string }[] = [];
      for await (const chunk of target.adapter.chat({
        model: target.model as string,
        apiKey: target.apiKey as string,
        baseUrl: target.baseUrl,
        messages: msgs,
        temperature: NPC_TEMPERATURE,
        maxTokens: NPC_MAX_TOKENS,
        streamMode: 'once',
        signal: opts.signal,
        ...(withTool ? { tools: [TRADE_TOOL], toolChoice: 'auto' as const } : {}),
      })) {
        if (chunk.content) acc += chunk.content;
        if (chunk.toolCalls?.length) calls = chunk.toolCalls;
        if (chunk.done) break;
      }
      return { text: acc, calls };
    };

    let draw: ChestDraw | null = null;
    let tradeNote: string | null = null;
    let acc = '';
    try {
      const first = await run(messages, true);
      acc = first.text;
      const wantsTrade = first.calls.some((c) => c.name === TRADE_TOOL.function.name);
      if (wantsTrade) {
        // ★ 领域取**他脚下这一格**，不取他的家：走位决定话题，也决定换来的词属于哪一块
        const domain = opts.here?.domain || opts.npc.domain;
        const r = npcTradeInDomain(opts.ownerId, opts.npc.id, domain);
        // 把工具结果喂回去，让他用自己的话把新词介绍出来（而不是服务端拼一句模板）
        const toolMsg = r.ok
          ? `换到了：「${r.draw.term}」（${r.draw.domain}）——释义：${r.draw.definition}。` +
            `用你自己的口气把它介绍给他，两三句，别念释义原文。今天还能换 ${r.tradesLeft} 次。`
          : `没换成。原因：${r.error} 用你自己的口气把这个原因告诉他，一句就够，别安慰过头。`;
        if (r.ok) {
          draw = r.draw;
        } else {
          tradeNote = r.error;
        }
        const second = await run(
          [...messages, { role: 'assistant', content: acc || '' }, { role: 'user', content: `（系统）${toolMsg}` }],
          false,
        );
        if (second.text.trim()) acc = second.text;
      }
    } catch {
      // 上游抖动也走降级：地图上的常驻元素不许因为一次报错变成"坏掉的功能"（§4.2）。
      acc = '';
    }
    if (acc.trim()) {
      recordNpcTurn({ sessionId, ownerId: opts.ownerId, userText: opts.text, reply: acc.trim() });
      return { reply: acc.trim(), source: 'ai', draw, tradeNote };
    }
  }
  // ★ 降级不落库（见文件头注最后一条）：罐头台词进了历史会污染之后每一轮。
  return { reply: npcFallbackLine(opts.npc.id, opts.seed ?? 0, opts.npc.term), source: 'fallback', draw: null };
}
