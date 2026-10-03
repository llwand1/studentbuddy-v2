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

/**
 * 「请把这个网址载入成本会话资料」——**请求**方向的一条广播（契约 `docs/POMODORO-SPEC.md` §5.5）。
 *
 * 与上面那条的区别：`DOC_CHANGED_EVENT` 是「已经改完了，去重取」，这条是「我想改，但我够不着」。
 * 发起方是番茄钟开钟卡（定下这一段学什么的时候顺手指定读哪篇），它长在督促抽屉里，
 * **没有 sessionId**，也不该为了这一个输入框去持有一份会话状态；
 * 真正能落地的是 `ChatView`（它持有 sessionId 与 `useDocMode`）——于是「谁想要」与「谁能做」
 * 用一条事件接上，抓取、提示、错误处理仍然只有 `useDocMode.submitUrl` 一份实现。
 *
 * ★ 没有打开对话页 / 还没有会话时这条事件没人接 ⇒ 发起方必须如实说「交给对话页了，去那边看结果」，
 *   不能假装已经载入（ADR-5 不静默）。
 */
export const DOC_URL_REQUEST_EVENT = 'sb:doc-url-request';

export function requestDocUrl(url: string): void {
  const target = url.trim();
  if (!target || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(DOC_URL_REQUEST_EVENT, { detail: { url: target } }));
}

/** 从事件里取回网址；形状不对一律 null（事件是开放总线，不信任 detail） */
export function readDocUrlRequest(e: Event): string | null {
  const detail: unknown = (e as CustomEvent).detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const url = (detail as { url?: unknown }).url;
  return typeof url === 'string' && url.trim() !== '' ? url.trim() : null;
}
