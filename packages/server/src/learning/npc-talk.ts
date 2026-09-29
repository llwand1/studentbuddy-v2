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
import type { ChatMessage } from '../llm/types.js';
import { resolveNpcTarget } from './npc-genesis.js';
import type { NpcView } from './npc.js';
import { NPC_TOOLS, runNpcTool, type NpcAgentAction } from './npc-agent-tools.js';
import type { ChestDraw } from './chest.js';
import { buildNpcMessages, ensureNpcSession, recordNpcTurn } from './npc-session.js';
import { aiText } from '../ai/gateway.js';

/**
 * ★ 工具箱见 `npc-agent-tools.ts`（Step 4 起伙伴是智能体：能查你的记忆、查词条关系、送新词）。
 *   交换做成工具而不是表单按钮的理由没变——它发生在**对话里**；新增的两个查询工具让他
 *   「先查再说」，而不是被提示词禁止谈进度。
 */
const MAX_STEPS = 3;

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
  /** 这一轮他用了哪些工具（按顺序；前端显示成「看了看你的记忆」这类小字） */
  actions?: NpcAgentAction[];
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
    '★ 说到用户的记忆情况（快忘了什么、搞错过什么）之前，先调 recall_learner_state；说到词条之间的关系，先调 related_terms。只说工具给你的事实，工具没给的一律不编（尤其是数字）。',
    '★ 卡牌数量、欠账、复习队列这些由别的面板说，你别提。',
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
    const run = async (msgs: ChatMessage[], withTools: boolean) => {
      // 经 AI 网关（超时 + 记账）；失败照旧抛给外层 try，走既有的降级台词
      const r = await aiText({
        purpose: 'npc.talk', ownerId: opts.ownerId, target, messages: msgs,
        temperature: NPC_TEMPERATURE, maxTokens: NPC_MAX_TOKENS, streamMode: 'once', signal: opts.signal,
        ...(withTools ? { tools: NPC_TOOLS, toolChoice: 'auto' as const } : {}),
      });
      if (!r.ok) throw new Error(r.error);
      return { text: r.text, calls: r.toolCalls ?? [] };
    };

    // ★ 领域与词条取**他脚下这一格**，不取他的家：走位决定话题，也决定查谁、换来的词属于哪一块
    const ctx = { ownerId: opts.ownerId, npcId: opts.npc.id, term: opts.here?.term || opts.npc.term, domain: opts.here?.domain || opts.npc.domain };
    let draw: ChestDraw | null = null;
    let tradeNote: string | null = null;
    const actions: NpcAgentAction[] = [];
    const used = new Set<string>();
    let acc = '';
    try {
      // 智能体循环：最多 MAX_STEPS 轮；每个工具一轮只执行一次（防止模型反复查同一件事烧钱），
      // 最后一轮不给工具 ⇒ 必须落到一句话上。结果以「（系统）」消息喂回（与原交换同一形状，不依赖各家 tool 消息格式）。
      let msgs = messages;
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const out = await run(msgs, step < MAX_STEPS - 1);
        if (out.text.trim()) acc = out.text;
        const calls = out.calls.filter((c) => !used.has(c.name));
        if (calls.length === 0) break;
        const results: string[] = [];
        for (const c of calls) {
          used.add(c.name);
          const r = runNpcTool(c.name, ctx);
          if (!r) continue;
          actions.push(r.action);
          if (r.draw) draw = r.draw;
          if (r.tradeNote) tradeNote = r.tradeNote;
          results.push(`【${c.name}】${r.result}`);
        }
        if (results.length === 0) break;
        msgs = [...msgs, { role: 'assistant', content: out.text || '' }, { role: 'user', content: `（系统）工具结果：\n${results.join('\n')}` }];
      }
    } catch {
      // 上游抖动也走降级：地图上的常驻元素不许因为一次报错变成"坏掉的功能"（§4.2）。
      acc = '';
    }
    if (acc.trim()) {
      recordNpcTurn({ sessionId, ownerId: opts.ownerId, userText: opts.text, reply: acc.trim() });
      return { reply: acc.trim(), source: 'ai', draw, tradeNote, actions };
    }
  }
  // ★ 降级不落库（见文件头注最后一条）：罐头台词进了历史会污染之后每一轮。
  return { reply: npcFallbackLine(opts.npc.id, opts.seed ?? 0, opts.npc.term), source: 'fallback', draw: null };
}
