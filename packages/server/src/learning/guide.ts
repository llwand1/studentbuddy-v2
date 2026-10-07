/**
 * learning/guide — 「下一步引导」的编排（契约 `docs/GUIDE-SPEC.md` §6–§7）：现场 → 阶段 → 白名单 → 模型挑并写文案 → 校验 → 兜底。
 *
 * ★ **永不 throw、永不 5xx**：引路灯是附加件。没绑模型 / 超时 / 上游错 / 输出不合格，一律退回规则推荐，
 *   `mode: 'rules'` 并带 `reason` 机器码——界面据此如实写「常用建议」与原因，不冒充 AI。
 * ★ 两个阶段**不问模型**：`busy`（AI 正在回答，没有可推荐的，只有一句话）与 `nomodel`（没模型，问了也白问）。
 * ★ 模型输出只能经 `normalizeGuideReply` 上屏：kind 闭集、文案限长、文本压成一行、必备项兜底（第一次＝随机话题、
 *   聊完＝出题、做完题＝一键解析）。「哪些动作此刻可选」是代码判的，模型只在里面挑并写文案。
 * ★ 走 AI 网关（用途 `guide.next`）：每次调用一行账；模型没给出合格 JSON 时网关会回喂错因修复一次。
 */
import {
  GUIDE_TOPICS,
  INTERACTIVE_AI_BUDGET,
  eligibleKinds,
  guideStage,
  normalizeGuideReply,
  ruleGuide,
  type GuideNextRequest,
  type GuideNextResponse,
} from '@sb/shared';
import type { ChatMessage } from '../llm/types.js';
import { routeRole } from '../llm/router.js';
import { aiJson } from '../ai/gateway.js';
import { buildGuideFacts } from './guide-facts.js';
import { buildGuidePrompt } from './guide-prompt.js';

/** 第一次打开要「每次都不一样」的话题，温度给高一点；其余阶段要的是贴着现场说话，低一点 */
const TEMPERATURE_FRESH = 0.95;
const TEMPERATURE_DEFAULT = 0.6;

/** 从模型输出里抠出第一个 JSON 对象（容忍前后夹带文字 / 代码围栏）；抠不出 ⇒ null */
export function extractJsonObject(text: string): unknown {
  const at = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (at < 0 || end <= at) return null;
  try {
    return JSON.parse(text.slice(at, end + 1)) as unknown;
  } catch {
    return null;
  }
}

export async function guideNext(
  ownerId: string | null,
  req: GuideNextRequest,
  opts: { signal?: AbortSignal; seed?: number } = {},
): Promise<GuideNextResponse> {
  const facts = buildGuideFacts(ownerId, req);
  const stage = guideStage(facts);
  /** 规则推荐里随机话题的种子：每次请求不同（「随机」），测试可注入 */
  const seed = opts.seed ?? Math.floor(Math.random() * GUIDE_TOPICS.length * 1000);
  const rules = ruleGuide(facts, seed);

  if (stage === 'busy') return { mode: 'rules', ...rules };
  if (stage === 'nomodel') return { mode: 'rules', reason: 'no-model', ...rules };

  const target = routeRole('explain', undefined, ownerId);
  if (!target?.model || !target.apiKey) return { mode: 'rules', reason: 'no-model', ...rules };

  const eligible = eligibleKinds(facts, stage);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildGuidePrompt(facts, stage, eligible) },
    { role: 'user', content: '请按要求给出此刻的下一步推荐（只回 JSON）。' },
  ];
  const r = await aiJson({
    purpose: 'guide.next',
    ownerId,
    target,
    messages,
    temperature: stage === 'fresh' ? TEMPERATURE_FRESH : TEMPERATURE_DEFAULT,
    maxTokens: INTERACTIVE_AI_BUDGET.maxTokens,
    repairMaxTokens: INTERACTIVE_AI_BUDGET.repairMaxTokens,
    totalTimeoutMs: INTERACTIVE_AI_BUDGET.totalMs,
    streamMode: 'once',
    signal: opts.signal,
    parse: (text) => normalizeGuideReply(extractJsonObject(text), facts, seed),
    repairHint: `只回 {"headline":"…","items":[{"kind":"…","label":"…","hint":"…","text":"…"}]} 这一个 JSON 对象；kind 只能取【可选动作】里列出的。`,
  });
  if (r.ok) return { mode: 'ai', ...r.value };
  return { mode: 'rules', reason: r.reason, ...rules };
}
