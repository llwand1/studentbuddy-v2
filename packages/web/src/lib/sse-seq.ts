/**
 * sse-seq — SSE 帧的 seq 去重判定（**纯函数**，从 `sse-client.ts` 抽出来只为可测）。
 *
 * ★ 抽出来的理由：这段判定此前**零测试**——`sse-client.ts` 是本仓 web 侧唯一一个没有任何用例的
 *   模块，而它错了也看不出来，因为错的表现是「帧被静默丢弃」而不是报错。本仓无 jsdom ⇒ 造不出
 *   `EventSource`，故把**判定**与**传输**解耦：传输留在 `sse-client.ts`，判定在这里被单一处测死。
 *
 * 规则（两条口径必须一起看，只看任一条都会写错）：
 *  ① **同一轮内** seq 单调递增 ⇒ `seq <= since` 是重复帧（断线重连的回放与 `/live` 快照会重叠），
 *     必须拦掉，否则 token 帧进两次回调、**文字翻倍**（v13 的教训）。
 *  ② **跨轮** seq 从 1 重计（服务端 `sse-bus.startNewRound` 会清缓冲），而本地 `since` 是跨轮保留的
 *     ⇒ 新一轮里 `seq <= since` 的帧**不是重复**，而是这个人的下一句话。全拦掉就会：
 *     「第二轮的开头半句不见了」；**且当新一轮比上一轮短时，连 `done` 都收不到** ⇒ 正文永不显示、
 *     输入框永久禁用（bug-ledger **B-007**，真机 CDP 实证：同一页面第二轮临时卡从半句中间开始）。
 *
 * 判据因此只有一个：**新一轮必定从 seq = 1 开始** ⇒ 见到 1 就把本地计数归零，其余照旧拦。
 *
 * @returns 接受则返回新的 `since`，丢弃则返回 `null`。
 */
export function acceptSeq(since: number, seq: number): number | null {
  if (seq <= since && seq !== 1) return null;
  return seq;
}
