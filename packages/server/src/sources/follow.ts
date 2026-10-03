/**
 * sources/follow —— 阅读页内跳转的**许可登记**（契约 `docs/SOURCE-TRACE-SPEC.md` §14.2）。
 *
 * 背景：`/view` 与 `/read` 原本只服务「本会话资料架上的网址」（§9），这是防止它变成开放代理。
 * 但「在侧栏里连续阅读」必然要访问不在架上的网址——点进去的那一篇当然没上过架。
 *
 * 授权模型选的是**把人设成闸门**：阅读页里的链接不直接跳，先弹一条确认（去哪个站、什么地址），
 * 用户点「在侧栏打开」才调 `POST /api/sources/follow` 把这个网址登记进本会话的许可集，
 * 随后的 `/read` 才认它。好处是它**可审计**——每一次越界都对应一次明确的人类点击，
 * 而不是一个前端能自行构造的签名。
 *
 * ★ 这没有引入新的能力等级：同一个已登录用户本来就能用 `POST /api/doc/url`（DOC-RAG-SPEC §10）
 *   让服务端抓任意网址。follow 只是把同一件事收进「必须先看见、再确认」的流程里。
 *   抓取一侧的 SSRF 防护仍然由 `fetchSafe` 逐跳负责，这里不重复实现。
 *
 * ★ 内存态、带 TTL 与上限：许可是**会话级的浏览足迹**，不值得落库；
 *   重启后退回「只认架上网址」是安全的方向（宁可让人再确认一次，不可悄悄多放行一个）。
 */

/** 与在线资料架同一个 TTL：超过这个时间没动静的会话，许可一并作废 */
const FOLLOW_TTL_MS = 2 * 60 * 60_000;
/** 单会话许可上限：一次学习里点开两百篇已经远超正常使用，再多就是脚本在刷 */
export const FOLLOW_MAX_PER_SESSION = 200;

const approved = new Map<string, { urls: Set<string>; at: number }>();

function prune(now: number): void {
  for (const [k, v] of approved) if (now - v.at > FOLLOW_TTL_MS) approved.delete(k);
}

/**
 * 记一次「用户确认过要去这里」。返回 false ＝ 撞上限（调用方应回 429 并提示重开会话），
 * 不静默丢弃——静默丢会让用户点了确认却跳不过去，且没有任何解释（ADR-5）。
 */
export function approveFollow(sessionId: string, url: string, now: number = Date.now()): boolean {
  prune(now);
  const cur = approved.get(sessionId) ?? { urls: new Set<string>(), at: now };
  if (!cur.urls.has(url) && cur.urls.size >= FOLLOW_MAX_PER_SESSION) return false;
  cur.urls.add(url);
  cur.at = now;
  approved.set(sessionId, cur);
  return true;
}

/** 这个网址是否被本会话确认过（`/read`、`/view`、`/probe`、`/shot` 的许可共用它） */
export function isFollowApproved(sessionId: string, url: string, now: number = Date.now()): boolean {
  const cur = approved.get(sessionId);
  if (!cur) return false;
  if (now - cur.at > FOLLOW_TTL_MS) {
    approved.delete(sessionId);
    return false;
  }
  return cur.urls.has(url);
}

/** 本会话已确认过几个（给面板显示「本次浏览足迹」用，也便于测试断言上限） */
export function followCount(sessionId: string): number {
  return approved.get(sessionId)?.urls.size ?? 0;
}

/** 测试与会话重置用 */
export function resetFollow(sessionId?: string): void {
  if (sessionId === undefined) approved.clear();
  else approved.delete(sessionId);
}
