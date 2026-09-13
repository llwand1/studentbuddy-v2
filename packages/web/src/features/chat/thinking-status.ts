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
