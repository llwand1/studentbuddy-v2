/**
 * features/continent/continent-hunt-store — 「一键讨伐」的**跨页交接**（2026-09-30，契约 KNOWLEDGE-CONTINENT-SPEC §「话题怪」）。
 *
 * 对话页的横幅说"刷新了新的怪物"，用户点「一键讨伐」⇒ 应用壳切到知识大陆 ⇒ 大陆页一挂载就要知道"去打哪几只"。
 * 两页不同时在场（`App` 按 `view` 单挂载），props 穿不过去；于是用一个**最小的模块级信箱**：
 * 对话页 `requestHunt(ids)` 投递，大陆页 `takeHunt()` 取走（取一次即清，防止下次进大陆又自动开打）。
 * ★ 不进 URL、不落 localStorage：它是一次性的意图，刷新页面就该忘掉（先例：`sources-store` 的 `pendingTurn`）。
 */

let pending: string[] | null = null;

/** 对话页：请求进大陆后依次讨伐这些词条的怪（按给定顺序） */
export function requestHunt(termIds: readonly string[]): void {
  pending = termIds.length > 0 ? [...termIds] : null;
}

/** 大陆页：取走待讨伐名单（取一次即清；没有 ⇒ `null`） */
export function takeHunt(): string[] | null {
  const out = pending;
  pending = null;
  return out;
}

/** 测试用 */
export function resetHuntStore(): void {
  pending = null;
}
