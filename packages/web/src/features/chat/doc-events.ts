/**
 * features/chat/doc-events —— 「本会话资料被别处改了」的一条广播。
 *
 * 为什么需要它：资料的**状态**由 `useDocMode` 持有（pill 挂在 composer 上方），
 * 但 2026-10-02 起多了**第二个载入入口**——资料架面板上的「存为资料」
 * （`features/sources/SaveAsDocButton.tsx`，SOURCE-TRACE-SPEC §8.2）。
 * 那块面板与 composer 不在同一棵子树上，也不共享 props。
 *
 * 为什么不升一个全局 store：资料状态的真相在**服务端**（刷新后靠 `GET /api/doc` 复原，
 * 本来就不在前端常驻）。再立一个前端 store 就是第二个真相源，还要自己维护它与服务端的一致性。
 * 这里只广播「变了，去重取」这一个事实，重取仍走同一个 GET——**没有第二份状态**。
 * 先例：`features/drill/drill-prefs.ts` 的 `DRILL_PREFS_EVENT` 也是这个形状。
 */
export const DOC_CHANGED_EVENT = 'sb:doc-changed';

/** 在非 composer 的地方改完资料后喊一声，让 pill 去重取（服务端已经是新的了） */
export function notifyDocChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DOC_CHANGED_EVENT));
}
