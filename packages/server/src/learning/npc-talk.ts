/**
 * learning/npc-talk — 伙伴对话：AI 优先，无 key 时降级到本地台词（契约 `docs/NPC-PARTNER-SPEC.md` §4）。
 *
 * ★★ 降级链照 `coach.ts` 的既有形状：`npc` 角色未绑定 ⇒ 回退 `explain`；连 model/apiKey 都没有 ⇒
 *   走 `NPC_FALLBACK_LINES`。**永不报错、永不空回**——伙伴是地图上的常驻元素，用户点他是
 *   "想跟伙伴说句话"，不是"提交一次模型调用"；报「没有可用的服务商」会让地图上多出一块
 *   **坏掉的功能**，而那正是本批立项要消灭的观感（"AI 含量太少"）。
 * ★ 但降级必须可识别：响应体带 `source: 'ai' | 'fallback'`，UI 据此说清并给出绑定指引。
 *   **降级可以，假装没降级不行**（ADR-5 的"报错说真话"在这里的等价物是"降级说真话"）。
 * ★ 上下文只给三块：人设（名字 + 他守的词条 + 领域）、他**当前是否遇险**、本轮输入。
 *   **不带全库卡墙/复习流水**："你还有 5 条欠账"由 coach 说，不由伙伴说——否则他会与任务清单打架。
 */
import { npcFallbackLine } from '@sb/shared';
import { routeRole } from '../llm/router.js';
import type { ChatMessage } from '../llm/types.js';
import type { NpcView } from './npc.js';

/** 短对话上限（伙伴说不长的话）；温度比 coach 的 0.6 高——伙伴要有人味 */
const NPC_MAX_TOKENS = 600;
const NPC_TEMPERATURE = 0.8;

export interface NpcTalkResult {
  reply: string;
  /** ★ `fallback` 不是"失败了"，是"现在只能这样"——前端必须据此说实话，不许当成正常 AI 回复 */
  source: 'ai' | 'fallback';
}

/** 与 `resolveCoachTarget` 同形：`npc` 未绑定 ⇒ 回退讲解（伙伴对话本质是日常对话，§4.1） */
export function resolveNpcTarget(ownerId: string | null) {
  const own = routeRole('npc', undefined, ownerId);
  if (own?.model) return own;
  return routeRole('explain', undefined, ownerId) ?? own;
}

function buildNpcPrompt(npc: NpcView): string {
  const state = npc.threat
    ? `你现在正被「${npc.threat.term}」的怪堵在领地上，很想有人来救你（用户答对那道题，怪就散了）。`
    : '你这会儿挺安好，附近没有怪。';
  return [
    `你是知识大陆上的学习伙伴「${npc.name}」，守着「${npc.term}」（领域：${npc.domain}）这一块地。`,
    '用第一人称、口语化、简短（两三句就够），像一个住在那儿的邻居；不要列条目、不要用标题、不要用列表符号。',
    `你能做的是：陪用户聊他守的这条词条、用提问或线索帮他记牢它、在他路过时提一句这附近有没有怪。`,
    `只聊「${npc.term}」和「${npc.domain}」这一块；被问到别的知识，就说那块地不是你守的。`,
    '★ 不要编造用户的学习进度、复习数字、卡牌数量、欠账——那些由别的面板说，你说了就会和它们对不上。',
    state,
  ].join('\n');
}

/**
 * 生成伙伴回复（请求-响应，不是流式：契约 §1 边界②——对话不订阅新 SSE）。
 * `seed` 是降级台词的轮换种子：库里**没有伙伴消息表**（零新表），拿不到"第几轮"，
 * 路由传本轮输入长度当轮次 ⇒ 不同问法给不同台词，同问法仍可复现（可单测）。
 */
export async function npcTalk(opts: {
  ownerId: string | null;
  npc: NpcView;
  text: string;
  seed?: number;
  signal?: AbortSignal;
}): Promise<NpcTalkResult> {
  const target = resolveNpcTarget(opts.ownerId);
  if (target?.model && target.apiKey) {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildNpcPrompt(opts.npc) },
      { role: 'user', content: opts.text },
    ];
    let acc = '';
    try {
      for await (const chunk of target.adapter.chat({
        model: target.model,
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        messages,
        temperature: NPC_TEMPERATURE,
        maxTokens: NPC_MAX_TOKENS,
        streamMode: 'once',
        signal: opts.signal,
      })) {
        if (chunk.content) acc += chunk.content;
        if (chunk.done) break;
      }
    } catch {
      // 上游抖动也走降级：地图上的常驻元素不许因为一次报错变成"坏掉的功能"（§4.2）。
      // 不记录具体错误在这里是**有意的**：`source='fallback'` 已经如实说了"这次不是 AI 答的"，
      // 前端会给出绑定指引；把上游报错原文透给用户，他既看不懂也无从下手。
      acc = '';
    }
    if (acc.trim()) return { reply: acc.trim(), source: 'ai' };
  }
  return { reply: npcFallbackLine(opts.npc.id, opts.seed ?? 0, opts.npc.term), source: 'fallback' };
}