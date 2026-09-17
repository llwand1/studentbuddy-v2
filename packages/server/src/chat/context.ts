/**
 * chat/context — 上下文组装与预算截断。
 * port from v1: alignToolRoundBoundary / truncateHistoryToBudget / estimateTokens / getContextLimit
 * （审查搬运：v1 崩溃级 bug「截断拆散工具轮致 API 400」的修复原样保留，API 正确性优先于严格预算）。
 */
import type { ChatMessage } from '../llm/types.js';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length;
  const nonCjk = text.replace(/[㐀-䶿一-鿿豈-﫿]/g, ' ');
  const words = nonCjk.trim() ? nonCjk.trim().split(/\s+/).length : 0;
  return cjk + words;
}

const CONTEXT_LIMITS: Array<[RegExp, number]> = [
  [/gpt-4\.1|gemini/, 1000000],
  [/gpt-5|gpt-4o|deepseek|agnes|claude/, 200000],
  [/qwen|glm|kimi/, 131072],
];
const DEFAULT_CONTEXT_LIMIT = 128000;

export function getContextLimit(model: string): number {
  const m = (model || '').toLowerCase();
  for (const [re, v] of CONTEXT_LIMITS) if (re.test(m)) return v;
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * 截断起点对齐完整工具轮：保留窗口头部不得落在孤儿 tool 消息上
 * （缺前置 assistant(tool_calls) 的 tool 开头序列会被 OpenAI/Anthropic 400 拒绝）。
 */
export function alignToolRoundBoundary(history: ChatMessage[], start: number): number {
  let s = Math.max(0, Math.min(start, history.length));
  let guard = 0;
  while (s > 0 && history[s]?.role === 'tool' && guard++ < 64) s--;
  if (history[s]?.role === 'tool') {
    // 历史起点即孤儿（数据缺陷）：丢弃头部 tool 消息
    while (s < history.length && history[s]?.role === 'tool') s++;
  }
  return s;
}

/** 按模型窗口预算截断（保留最新丢最旧；始终保留最后一轮；边界对齐工具轮）。 */
export function truncateHistoryToBudget(
  history: ChatMessage[],
  opts: { limit: number; systemPromptTokens: number; reserveTokens?: number },
): ChatMessage[] {
  if (!history || history.length === 0) return history;
  const reserve = opts.reserveTokens ?? 20000;
  const budget = opts.limit - opts.systemPromptTokens - reserve;
  if (budget <= 0) {
    return history.slice(alignToolRoundBoundary(history, history.length - 2));
  }
  let used = 0;
  let startIdx = history.length;
  let hasUser = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) break; // noUncheckedIndexedAccess 防御（循环边界内不会发生）
    const t = estimateTokens((m.content || '') + (m.toolCalls ? JSON.stringify(m.toolCalls) : ''));
    if (used + t > budget && hasUser) {
      startIdx = i + 1;
      break;
    }
    used += t;
    if (m.role === 'user') hasUser = true;
    startIdx = i;
  }
  return history.slice(alignToolRoundBoundary(history, startIdx));
}

/**
 * 丢弃已被会话摘要覆盖的历史（`rowid <= uptoRowid` 的部分）。
 *
 * 摘要段会以文本形式提供这些内容（`chat/compact.ts` 的 `buildSummaryBlock`），
 * 若再把原文一起发出去，同一段内容会在窗口里出现两次——白占预算，
 * 也削弱「摘要是浓缩」的意义。与 Pi 的 `firstKeptEntryId` 同一语义。
 *
 * 用泛型而非 import `HistoryMessage`：本文件是**纯文本工具**，不该知道 DB 概念
 * （与 `persist.ts` 把 rowid 做成子类型是同一取向）。
 *
 * 起点仍要过一遍工具轮对齐：锚点写库时已对齐过，但它是**库里的历史数据**——
 * 手改库、未来逻辑变更、或锚点写入与消息写入的时序错位都可能让它落在工具轮中间。
 */
export function dropSummarizedHistory<T extends ChatMessage & { rowid: number }>(
  history: T[],
  uptoRowid: number,
): T[] {
  if (!uptoRowid) return history;
  const kept = history.filter((m) => m.rowid > uptoRowid);
  return kept.slice(alignToolRoundBoundary(kept, 0));
}
