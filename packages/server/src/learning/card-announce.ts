/**
 * learning/card-announce — 卡数变了就推一帧（契约 `docs/TERM-CARDS-SPEC.md` §7.2 的 `card_granted`）。
 *
 * ★ 为什么单独一个文件、不放 `term-cards.ts`：那个模块文件头第一句就是「**本文件没有任何写入口**」，
 *   它的全部价值在于"只有一个地方读那三张流水"。把 SSE 推送塞进去，读出口就长出了副作用，
 *   而它是被 `/state`、派单、判完成三条路反复调用的——任何一次读数都想推一帧的话，
 *   派单一次就是十几帧。⇒ 推送是**写侧**的事，写在侧的家在这。
 * ★ 为什么在**写侧**直接 publish、不走 `events/bus.ts` 订阅：本仓两种写法都有先例，
 *   分界是"发布方知不知道自己在改卡数"。`trend.ts`／`quiz-announce.ts`／`pk/*` 都是知道的那一类，
 *   本文件这三处也是（调用点就在写流水的那几行之后）；走总线要为一条总线多养一个事件类型，
 *   而它唯一的消费者就是这里。
 * ★★ 推的是**绝对卡数**，不是增量：断线重连后重放一帧就能对齐，前端不需要自己累加。
 *   增量在服务端没有事实源（卡数本就是三张流水现算的派生值），发增量等于让前端去猜
 *   ——B-007/009/010「前端猜服务端事实」那一族 bug 的形状。
 * ⚠️ 无订阅者时 `publish` 是安全空转（只进缓冲区，60 秒 TTL 回收，见 `chat/sse-bus.ts`），
 *   所以本函数**不判**"有没有人开着 `/stream`"。判了就得依赖订阅状态，而订阅状态不该影响事实。
 */
import { cardsChannel } from '@sb/shared';
import { publish } from '../chat/sse-bus.js';
import { cardsLogSince, termCards } from './term-cards.js';

/**
 * 把这几个词条的**当前**卡数推给本人的卡牌频道。
 *
 * @param termIds 本轮真正变了的词条 id；★ 空数组直接返回——不发空帧，
 *   前端收到空 `grants` 只能选择"忽略"或"重拉 /state"，两条都是白做的功。
 */
export function announceCards(ownerId: string | null, termIds: readonly string[]): void {
  if (termIds.length === 0) return;
  const grants: Array<{ termId: string; cards: number; star: number }> = [];
  for (const termId of termIds) {
    // ★ 逐条查而不是 `cardsByTerm` 全量：调用点每次都只碰一到几条，
    //   而全量聚合是"整个库"的量级（一次 `/state` 才该跑它）。
    const c = termCards(termId, ownerId);
    if (c) grants.push({ termId: c.termId, cards: c.cards, star: c.star });
  }
  if (grants.length === 0) return;
  const channel = cardsChannel(ownerId);
  publish(channel, { type: 'card_granted', sessionId: channel, grants, logSince: cardsLogSince(ownerId) });
}
