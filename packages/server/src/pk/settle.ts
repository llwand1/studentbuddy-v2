/**
 * pk/settle — 对局收尾：结算与投降（契约 docs/PK-SPEC.md §1 结算表 / §12.1 投降，P0-8）。
 *
 * ★ 从 `match.ts` 搬出**并**扩容：原 `settleRoom`（时钟归零结算）与新增 `forfeitRoom`（认输）
 *   走**同一条收尾路径** `finishRoom`。两种结束方式只差「谁赢」与「为什么结束」，
 *   分开写就会出现「投降忘了广播 pk-end」「投降不落历史」这类只在一半代码里成立的规则。
 *
 * ★ 独立成文件的两个理由：① `match.ts` 当时已 389/400 行（AGENTS 红线 400），
 *   再往里加必撞；② 路由层也要能调 `forfeit`，而不该去 import `match.ts` 的私有收尾。
 *   依赖方向刻意单向：`settle → room/history/sse-bus`，`match → settle`，**不成环**
 *   （`match.ts` 与 `judge.ts` 那次 `PK_QUIZ_MIX` 成环的教训）。
 *
 * ★ 本文件**不碰 ticker**：`tickMatches` 末尾已无条件调 `stopTickerIfIdle()`，最迟 1s 内自停。
 *   在这里再引一次 `match.ts` 会让上面那条单向依赖变成环——为一次「早 1 秒停」的优化不值得。
 */
import { pkChannel, type PkEndReason, type PkIdentity, type PkRoomError, type PkRoomState } from '@sb/shared';
import { publish } from '../chat/sse-bus.js';
import { recordMatch } from './history.js';
import { requireRoomInternal, snapshotRoom, type Room } from './room.js';

function fail(code: PkRoomError): never {
  throw new Error(code);
}

/**
 * 收尾唯一路径：置 finished → 定胜者 → 记结束原因 → 广播 `pk-end` → 落历史。
 * `winnerId` 为 undefined 即平局（只有时钟归零可能出现）。
 *
 * ★ 顺序刻意是「**先广播、后落库**」：广播是当场感知（玩家盯着屏幕等结果），
 *   历史是事后可查。落库慢一步不该让人多等——`recordMatch` 自身也吞异常不阻断。
 * ★ 幂等：非 active 房直接返回（ticker 与投降同时在途时，后到的那个不会重复收尾）。
 */
export function finishRoom(room: Room, winnerId: string | undefined, reason: PkEndReason, now = Date.now()): void {
  if (room.status !== 'active') return;
  room.status = 'finished';
  // `timeup` 不写：它的语义就是「时钟归零」，老字段口径不变；只有非时间到的结束才需要显式标注
  if (reason === 'forfeit') room.endReason = reason;
  if (winnerId) room.winner = winnerId;
  else delete room.winner;
  room.aiBusy = false;
  room.lastActivity = now;
  const state = snapshotRoom(room);
  publish(pkChannel(room.roomId), {
    type: 'pk-end',
    roomId: room.roomId,
    ...(room.winner ? { winner: room.winner } : {}),
    state,
  });
  recordMatch(state, reason, now);
}

/** 时钟归零结算：分高者胜 → 平分比答对数 → 仍平为平局（契约 §1）。 */
export function settleRoom(room: Room, now = Date.now()): void {
  if (room.status !== 'active') return;
  const ranked = [...room.players].sort((a, b) => b.score - a.score || b.correct - a.correct);
  const top = ranked[0];
  const second = ranked[1];
  const tie = top !== undefined && second !== undefined && top.score === second.score && top.correct === second.correct;
  finishRoom(room, tie ? undefined : top?.userId, 'timeup', now);
}

/**
 * 认输（契约 §12.1）：对手直接胜，**比分定格**（老板拍板：不额外扣分、也不退回分）。
 *
 * 语义边界：投降方必须是房内玩家（不在房内 403 `NOT_A_PLAYER`）、且对局进行中
 * （waiting 房没有输赢可认、已结束的房认输无意义，都 409 `ROOM_NOT_ACTIVE`）。
 * ★ 不做「只有分低的人才能投降」这类额外限制——那等于替玩家判断局势，
 *   而投降的正当用途恰恰包括「我分高但得走了」。
 */
export function forfeitRoom(roomIdRaw: unknown, identity: PkIdentity, now = Date.now()): PkRoomState {
  const room = requireRoomInternal(roomIdRaw);
  const me = room.players.find((p) => p.userId === identity.userId);
  if (!me) fail('NOT_A_PLAYER');
  if (room.status !== 'active') fail('ROOM_NOT_ACTIVE');
  // 双人局里对手必然存在；兜底不静默（缺对手 = 状态机坏了，不能悄悄把人判胜）
  const opponent = room.players.find((p) => p.userId !== identity.userId);
  if (!opponent) fail('ROOM_NOT_ACTIVE');
  finishRoom(room, opponent.userId, 'forfeit', now);
  return snapshotRoom(room);
}
