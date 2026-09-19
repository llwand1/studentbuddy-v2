/**
 * thinking-status —— 「思考中」状态的文案与计时（纯函数，供 ThinkingIndicator 与单测共用）。
 * 老板在 v1 就要过的「思考态文案池轮播」在 v2 补上：等待期不再是干瘪的三点弹跳，
 * 而是轮播短语 + 已用时计时。池中 AI（一次性回答）的整个等待期、原生 AI 的首 token 前空窗
 * 都走这一份——它是等待态，不区分 provider。
 */

/** 轮播短语池：中性、不撒谎（不承诺「正在联网」这类没发生的事） */
const PHRASES = ['正在思考', '正在组织回答', '正在梳理思路', '正在认真想', '马上就好'];

/** 单短语停留时长（ms）：太短闪瞎，太长像卡死 */
const PHRASE_INTERVAL_MS = 4000;

export function thinkingPhrase(elapsedMs: number): string {
  const idx = elapsedMs <= 0 ? 0 : Math.floor(elapsedMs / PHRASE_INTERVAL_MS) % PHRASES.length;
  return PHRASES[idx] ?? '正在思考';
}

/** 已用时格式化：<60s 显示「x.xs」，≥60s 显示「m分ss秒」 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(totalSec / 60)}分${String(totalSec % 60).padStart(2, '0')}秒`;
}

/**
 * 卡片耗时三档（P1，抄 LobeChat `ExecutionTime.tsx` 口径，契约 TOOL-ECOSYSTEM-SPEC §4.7）：
 * `<1000ms → 823ms`（亚秒工具显示 ms，`(0.8s)` 精度不够还显得没跑完）、`<60s → 4.2s`、否则 `1min12s`。
 * ★ 与 `formatElapsed` 刻意分开：那个是「等待中已用时」（每 200ms 跳动，秒位无意义以下都是噪声），
 *   这个是「终态后冻结的实测值」（要精确）。两口径合并必然一头将就另一头——存储恒为 ms，格式化只在展示层。
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}min${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/**
 * 阶段感知的状态文案（v13 体验升级 P0）：不再盲转——
 * 有工具在跑就说真话（「联网搜索：闭包」），思考链在流就说「深度思考中」，
 * 都没有才回落到轮播短语池。数据全部来自已有的 step / reasoning 事件，零新事件。
 */
export interface PhaseStep {
  tool: string;
  status: string;
  detail?: string;
}

/** 工具名 → 用户视角动作（与 chat/tools.ts 注册表对应；未知工具名原样展示） */
export const TOOL_LABELS: Record<string, string> = {
  search_web: '联网搜索',
  tidy_terms: '整理词条库',
  manage_terms: '维护词条库',
  update_tasks: '规划任务',
};

/** detail 展示上限：状态行不能被长 query 撑爆 */
const DETAIL_MAX_CHARS = 24;

export function phaseStatus(steps: PhaseStep[], reasoningLen: number, elapsedMs: number): string {
  const running = [...steps].reverse().find((s) => s.status === 'running');
  if (running) {
    const label = TOOL_LABELS[running.tool] ?? running.tool;
    const detail = (running.detail ?? '').trim();
    return detail ? `${label}：${detail.slice(0, DETAIL_MAX_CHARS)}${detail.length > DETAIL_MAX_CHARS ? '…' : ''}` : `${label}中`;
  }
  if (reasoningLen > 0) return '深度思考中';
  return thinkingPhrase(elapsedMs);
}
