/**
 * pk/power — 道具与二次机会（P0-7，2026-09-13 老板点单）。
 *
 * 两条能力都不改计分主表，只在主表之上**加补救通道**：
 * ① `useHelp`      —— 求助 AI：每局每人 1 个，用掉即止；裁判**当场联网搜索**后给建议与知识输出（**不给答案**）
 * ② `requestRetry` —— 错题二次机会：选一道自己答错的题 → 现场解析 + 同主题类似题 → 作对 +2；3 分钟 CD
 *
 * ★ 为什么单独成文件而不塞进 match.ts：match 已贴 400 行门禁（server 单文件上限），
 *   且这两条的语义是「补救通道」而非「计分主路径」，混进主路径只会让它更难读。
 * ★ 两者都**不产出新计分规则**：二次机会的题走既有 `submitAnswer`（答对 +2 / 答错 −1），
 *   不另写一套判分——新题种是新通道，不是新账本。
 */
import {
  ANSWER_TIME_MS,
  JUDGE_USER_ID,
  RETRY_CD_MS,
  pkChannel,
  type PkJudgeAdvice,
  type PkQuestion,
  type PkRoomError,
  type PkRoomState,
} from '@sb/shared';
import { publish } from '../chat/sse-bus.js';
import { explainAndRetry, helpWithQuestion } from './judge.js';
import { answerIndex, snapshotQuestion } from './match.js';
import { requireRoomInternal, snapshotRoom, type PkRoomQuestion, type Room } from './room.js';

/** 与 match.ts 同形状的域错误：message 是错误码（路由层据此查状态码），extra 是随错误回传的附加数据 */
class PkFail extends Error {
  constructor(code: PkRoomError, readonly extra?: unknown) {
    super(code);
    this.name = 'PkFail';
  }
}

function fail(code: PkRoomError, extra?: unknown): never {
  throw new PkFail(code, extra);
}

function broadcastState(room: Room): void {
  publish(pkChannel(room.roomId), { type: 'pk-state', roomId: room.roomId, state: snapshotRoom(room) });
}

// ── ① 求助 AI 道具 ─────────────────────────────────────────

/**
 * 用掉求助道具，就场上某道题请裁判指点。
 * ★ 校验顺序刻意为之：**先看道具还有没有，再看题存不存在**——道具是稀缺资源，
 *   若题不存在先报错，玩家会以为「我道具是不是被扣了」，而实际上没扣也说不清。
 */
export async function useHelp(
  roomId: string,
  userId: string,
  rawQuestionId: unknown,
  now = Date.now(),
  ownerId: string | null = null,
): Promise<{ advice: PkJudgeAdvice; state: PkRoomState }> {
  const room = requireRoomInternal(roomId);
  if (room.status !== 'active') fail('ROOM_NOT_ACTIVE');
  const me = room.players.find((p) => p.userId === userId);
  if (!me) fail('NOT_A_PLAYER');
  if (me.helpLeft <= 0) fail('HELP_EXHAUSTED');
  const q = room.questions.find((x) => x.id === rawQuestionId);
  if (!q) fail('QUESTION_NOT_FOUND');

  // M2c：求助是"当场联网搜索 + 裁判模型"两次出站，归属取发起者（契约 §8.1.4）
  const advice = await helpWithQuestion(q.topic ?? room.currentTopic, q.stem, q.options, ownerId);
  if (!advice) fail('JUDGE_UNAVAILABLE');

  me.helpLeft -= 1;
  room.lastActivity = now;
  broadcastState(room);
  return { advice, state: snapshotRoom(room) };
}

// ── ② 错题二次机会 ─────────────────────────────────────────

export interface RetryResult {
  /** 裁判对那道错题的现场解析（错在哪 / 正确思路） */
  explanation: string;
  /** 同主题的类似题；出题失败时为 null —— **解析照给**，二次机会不该因出题失败整个消失 */
  question: PkQuestion | null;
  state: PkRoomState;
}

/**
 * 选一道自己答错（或超时）的题，换取一次补救：裁判先给现场解析，再按同一主题出一道类似题。
 * 类似题答对 +2（走既有 `submitAnswer`），原错题那 −1 **不撤销**（老板拍板：答错就是答错了）。
 */
export async function requestRetry(
  roomId: string,
  userId: string,
  rawQuestionId: unknown,
  now = Date.now(),
  ownerId: string | null = null,
): Promise<RetryResult> {
  const room = requireRoomInternal(roomId);
  if (room.status !== 'active') fail('ROOM_NOT_ACTIVE');
  const me = room.players.find((p) => p.userId === userId);
  if (!me) fail('NOT_A_PLAYER');
  const unlock = room.retryNextAt[userId] ?? 0;
  if (unlock > now) fail('RETRY_ON_COOLDOWN');

  const q = room.questions.find((x) => x.id === rawQuestionId);
  if (!q) fail('QUESTION_NOT_FOUND');
  if (q.toUserId !== userId) fail('RETRY_NOT_YOURS');
  // 只有「已经答错」的题配补救：pending 还没有结果，答对的不需要补
  if (q.status === 'pending') fail('RETRY_NO_TARGET');
  if (q.chosen !== undefined && q.chosen === q.answer) fail('RETRY_NO_TARGET');

  const topic = q.topic ?? room.currentTopic;
  const pack = await explainAndRetry(topic, q.stem, q.options, q.answer, q.chosen ?? -1, ownerId);
  if (!pack) fail('JUDGE_UNAVAILABLE');

  // 落 CD：解析已经给出去了，这次机会就算用过——不落的话可以反复刷解析（虽不加分，但会拖垮对局节奏）
  room.retryNextAt[userId] = now + RETRY_CD_MS;

  let created: PkRoomQuestion | null = null;
  const g = pack.generated;
  const answer = g ? answerIndex(g.answer) : null;
  if (g && answer !== null && g.options && g.options.length >= 2 && answer < g.options.length) {
    created = {
      id: `pq-${room.roomId}-${room.questions.length + 1}`,
      roomId: room.roomId,
      // 出题人记为裁判：这题不是任何一方出的，不给任何人 +1（二次机会只给答题人加分）
      fromUserId: JUDGE_USER_ID,
      toUserId: userId,
      prompt: `二次机会·${topic}`,
      stem: String(g.question),
      options: g.options.map(String),
      createdAt: now,
      deadlineAt: now + ANSWER_TIME_MS,
      status: 'pending',
      answer,
      topic,
      retryOf: q.id,
      isRetry: true,
    };
    room.questions.push(created);
  }

  room.lastActivity = now;
  broadcastState(room);
  return {
    explanation: pack.explanation,
    question: created ? snapshotQuestion(created) : null,
    state: snapshotRoom(room),
  };
}
