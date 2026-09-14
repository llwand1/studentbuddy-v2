/**
 * session-busy —— 侧栏「回复中」徽标的判据（纯函数，供 App 与单测共用）。
 *
 * ## 修的是什么 bug（2026-09-14 老板实测报的）
 * 「回复中的效果在点击无关对话时也会出现，而原来正在回答的那个对话的效果会消失」。
 * 病根不在渲染，在**信号来源**：徽标当时只看 `useChatStream` 上报的 `busy`，
 * 而上报用的是「当前挂载的 sessionId」，切页时 `busy` 又没清零 ⇒ 上一间的 busy 被
 * 记到了刚点开的那一间头上（漂移），原来那间反而没了标记。
 *
 * ## 为什么要有两个来源，而不是只留服务端
 * - `localSid`（当前挂载会话的实时信号）：token 级零延迟。只留服务端的话，2s 轮询
 *   会让「刚点发送」到「徽标亮起」之间有肉眼可见的空档。
 * - `serverSids`（服务端 `/api/chat/active`）：覆盖「生成发生在别的会话里」——**生成不随
 *   切页中止**（见 routes.ts `/active` 注释），这是客户端无论如何都推不出来的部分。
 * 两个来源都以**正确的会话 id** 标注，取并集即是真相；缺任一都会漏一种场景。
 */

/** 侧栏该打「回复中」的会话集合 = 服务端在跑的 ∪ 当前页正在流的那一个 */
export function busySessionIds(localSid: string | null, serverSids: readonly string[]): Set<string> {
  const set = new Set(serverSids);
  // 空串不是合法会话 id，但 defensive：宁可忽略也不能造出一个 "" 的项去撞列表
  if (localSid) set.add(localSid);
  return set;
}

/**
 * 轮询闸门：只在真有会话在跑时才盯服务端。
 * 空闲时零请求（否则一个后台 2s 心跳会一直存在，纯浪费）。
 */
export function shouldPollActive(busy: ReadonlySet<string>): boolean {
  return busy.size > 0;
}

/**
 * 两个 id 列表是否逐项相同（顺序也认）。
 * 用途：轮询回来内容没变时**保持原引用**，否则每 2s 一次 setState 会让 App 与
 * ChatView 白白重渲染一轮——流式期间每 2s 打断一次渲染调度，是能感觉到的浪费。
 */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
