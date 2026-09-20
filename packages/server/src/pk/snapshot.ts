/**
 * pk/snapshot — 房间与题目的对外快照（§15 B4 从 match.ts / room.ts 合流）。
 *
 * 为什么抽成独立文件：① 对外载荷映射原来在 match.ts（snapshotQuestion）与 room.ts
 * （snapshotRoom 内联一份几乎相同的题目映射）**各写一份**——§15.4 的情景题分支一加，
 * 「criteria 不外泄」的纪律就要靠两处同时不犯错，迟早漂移；② match.ts 已贴 400 行门禁。
 * ★ 全仓「房内题 → 对外题」的映射**只此一份**：`answer` / `criteria` / demo 源码
 *   能不能出现在载荷里，看这里就够了。
 */
import type { PkQuestion, PkRoomState } from '@sb/shared';
import type { PkRoomQuestion, Room } from './room.js';

/**
 * 内部题 → 对外载荷。
 * ★ 客观题：`answer` 只在判定后以 `answerRevealed` 出现；pending 连键都没有。
 * ★ 情景题（kind='scenario'）：下发 `scenario`（demoId + 评分点，**不含 criteria**）
 *   与 `taskResults`（只回填已判定的键）；`chosen`/`answerRevealed` 结构性不出现——
 *   情景题没有「选项下标」这种答案，`scenarioInternal`（criteria + demo 源码）永不出门。
 */
export function snapshotQuestion(q: PkRoomQuestion): PkQuestion {
  const base: PkQuestion = {
    id: q.id,
    roomId: q.roomId,
    fromUserId: q.fromUserId,
    toUserId: q.toUserId,
    prompt: q.prompt,
    stem: q.stem,
    options: [...q.options],
    createdAt: q.createdAt,
    deadlineAt: q.deadlineAt,
    status: q.status,
  };
  if (q.topic) base.topic = q.topic;
  if (q.retryOf) base.retryOf = q.retryOf;
  if (q.isRetry) base.isRetry = true;
  if (q.kind === 'scenario') {
    base.kind = 'scenario';
    const internal = q.scenarioInternal;
    if (internal) {
      base.scenario = {
        demoId: internal.demoId,
        title: q.stem,
        tasks: internal.tasks.map((t) => (t.hint ? { id: t.id, prompt: t.prompt, hint: t.hint } : { id: t.id, prompt: t.prompt })),
      };
    }
    if (q.taskResults) base.taskResults = { ...q.taskResults };
    return base;
  }
  if (q.chosen !== undefined) {
    base.chosen = q.chosen;
    if (q.answer !== undefined) base.answerRevealed = q.answer;
    return base;
  }
  if (q.status !== 'pending' && q.answer !== undefined) base.answerRevealed = q.answer;
  return base;
}

/**
 * 派生对外快照：players/questions 逐层复制，防调用方改到内部状态。
 * ★ 题目映射全部走 `snapshotQuestion`（含情景题分支）——本函数不再自带一份。
 */
export function snapshotRoom(room: Room): PkRoomState {
  const state: PkRoomState = {
    roomId: room.roomId,
    roomCode: room.code,
    status: room.status,
    mode: room.mode,
    players: room.players.map((p) => ({ ...p })),
    nextQuizAt: { ...room.nextQuizAt },
    endsAt: room.endsAt,
    questions: room.questions.map((q) => snapshotQuestion(q)),
    currentTopic: room.currentTopic,
    topicOwnerId: room.topicOwnerId,
    topicTurn: room.topicTurn,
    retryNextAt: { ...room.retryNextAt },
  };
  if (room.aiTopic) state.aiTopic = room.aiTopic;
  if (room.winner) state.winner = room.winner;
  if (room.endReason) state.endReason = room.endReason;
  // UX 批：出题中（公开事实，双方都该看到「谁在出题」）
  if (room.quizPending) state.quizPending = room.quizPending;
  return state;
}
