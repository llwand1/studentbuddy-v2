/**
 * pk/match — PK 对局引擎（契约 docs/PK-SPEC.md §1 计分表 / §3 出题管道，P0-2）。
 *
 * 计分唯一事实源：+1 成功出题 / +2 答对 / −1 答错 / −1 超时 / −1 怠慢（可累计，可为负）。
 * 所有计时都在服务端：出题 CD 与答题时限用时间戳比对，超时/怠慢/结算由 **1s ticker 统一驱动**
 * （`tickMatches`，时间驱动的逻辑收口一处，测试用假时钟直接调它，不起真定时器）。
 *
 * PVE 与 PVP 走**同一条计分路径**：AI 出题/答题最终都落到本文件的写入函数上，
 * 人机对称不是口号，是代码路径相同（AI 代理见 ai-bot.ts）。
 */
import {
  ANSWER_TIME_MS,
  AI_RETRY_DELAY_MS,
  IDLE_PENALTY_MS,
  PK_PROMPT_MAX,
  QUIZ_CD_MS,
  pkChannel,
  type PkRoomError,
  type PkRoomState,
  type QuizMix,
} from '@sb/shared';
import type { QuizPayload, QuizQuestion } from '@sb/shared';
import { publish } from '../chat/sse-bus.js';
import { generateQuiz } from '../learning/quiz.js';
import { allRoomsInternal, requireRoomInternal, snapshotRoom, type PkRoomQuestion, type Room } from './room.js';
import { runAiAnswer, runAiQuiz } from './ai-bot.js';

/** PK 出题固定「一道单选」——系统约束层直接用配比表达，不另写提示词分支 */
export const PK_QUIZ_MIX: QuizMix = { single: 1, multiple: 0, fill: 0, essay: 0 };

function fail(code: PkRoomError): never {
  throw new Error(code);
}

/** 状态变更 → 房间频道广播（契约 §2.2：客户端不靠轮询发现变化） */
export function publishState(room: Room): void {
  publish(pkChannel(room.roomId), { type: 'pk-state', roomId: room.roomId, state: snapshotRoom(room) });
}

function memberOf(room: Room, userId: string) {
  return room.players.find((p) => p.userId === userId);
}

function opponentOf(room: Room, userId: string) {
  return room.players.find((p) => p.userId !== userId);
}

/** QuizQuestion.answer（number|number[]|string…）→ 单选下标；不合法 → null */
function answerIndex(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === 'number' && Number.isInteger(raw[0])) {
    return raw[0];
  }
  return null;
}

/**
 * 把一道已生成的单选题写进对局并给出题人 +1（PVP/PVE 共用唯一写入口——
 * AI 出题不是另一套计分）。生成物不合法返回 false，由调用方按「AI 失败免费重试」处理。
 */
export function pushGeneratedQuestion(
  room: Room,
  fromUserId: string,
  toUserId: string,
  prompt: string,
  generated: QuizQuestion | undefined,
  now: number,
): boolean {
  const answer = answerIndex(generated?.answer);
  if (!generated || !generated.options || generated.options.length < 2 || answer === null || answer >= generated.options.length) {
    return false;
  }
  const question: PkRoomQuestion = {
    id: `pq-${room.roomId}-${room.questions.length + 1}`,
    roomId: room.roomId,
    fromUserId,
    toUserId,
    prompt,
    stem: String(generated.question),
    options: generated.options.map(String),
    createdAt: now,
    deadlineAt: now + ANSWER_TIME_MS,
    status: 'pending',
    answer,
  };
  room.questions.push(question);
  const author = memberOf(room, fromUserId);
  if (author) author.score += 1;
  room.lastActivity = now;
  publish(pkChannel(room.roomId), { type: 'pk-question', roomId: room.roomId, question: snapshotQuestion(question) });
  publishState(room);
  return true;
}

/**
 * 出题：校验（active / 在房 / CD）→ 先落 CD 并广播（双方立刻看到倒计时）
 * → 调出题管道 → 成功建题 +1 并广播；失败回滚 CD（= 契约「失败可免费重试，不计 CD」）。
 */
export async function submitQuiz(
  roomId: string,
  userId: string,
  rawPrompt: unknown,
  now = Date.now(),
): Promise<PkRoomState> {
  const room = requireRoomInternal(roomId);
  if (room.status !== 'active') fail('ROOM_NOT_ACTIVE');
  const author = memberOf(room, userId);
  if (!author) fail('NOT_A_PLAYER');
  const opponent = opponentOf(room, userId);
  if (!opponent) fail('ROOM_NOT_ACTIVE');
  if (typeof rawPrompt !== 'string' || !rawPrompt.trim()) fail('PROMPT_INVALID');
  const prompt = rawPrompt.trim().slice(0, PK_PROMPT_MAX);

  const prevCd = room.nextQuizAt[userId];
  if ((prevCd ?? 0) > now) fail('QUIZ_ON_COOLDOWN');
  room.nextQuizAt[userId] = now + QUIZ_CD_MS;
  author.lastQuizAt = now;
  room.idleAnchor[userId] = now;
  room.lastActivity = now;
  publishState(room);

  let payload: QuizPayload | null = null;
  try {
    payload = await generateQuiz(prompt, undefined, PK_QUIZ_MIX);
  } catch {
    payload = null;
  }
  const ok = pushGeneratedQuestion(room, userId, opponent.userId, prompt, payload?.questions.find((x) => x.type === 'single'), now);
  if (!ok) {
    if (prevCd === undefined) delete room.nextQuizAt[userId];
    else room.nextQuizAt[userId] = prevCd;
    publishState(room);
    fail('AI_GENERATION_FAILED');
  }

  // PVE：这道题是发给 AI 的 → 立刻安排 AI 答题（异步，同人一条判分路径）
  if (room.mode === 'pve' && opponent.userId.startsWith('ai-')) {
    const q = room.questions[room.questions.length - 1];
    if (q) void runAiAnswer(room.roomId, q);
  }
  return snapshotRoom(room);
}

/** 内部题 → 对外载荷（answer 只在判定后以 answerRevealed 出现） */
function snapshotQuestion(q: PkRoomQuestion) {
  const base = {
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
  if (q.chosen !== undefined) return { ...base, chosen: q.chosen, answerRevealed: q.answer };
  if (q.status !== 'pending') return { ...base, answerRevealed: q.answer };
  return base;
}

/**
 * 答题：校验（active / 在房 / 题存在 / 是发给你的 / 还没被答或判超时）→ 即时判分。
 * AI 与人共用本函数（同口径），无需第二套计分。
 */
export function submitAnswer(
  roomId: string,
  userId: string,
  rawQuestionId: unknown,
  rawChoice: unknown,
  now = Date.now(),
): { correct: boolean; delta: number; score: number } {
  const room = requireRoomInternal(roomId);
  if (room.status !== 'active') fail('ROOM_NOT_ACTIVE');
  const answerer = memberOf(room, userId);
  if (!answerer) fail('NOT_A_PLAYER');
  const q = room.questions.find((x) => x.id === rawQuestionId);
  if (!q) fail('QUESTION_NOT_FOUND');
  if (q.toUserId !== userId) fail('QUESTION_NOT_YOURS');
  if (q.status !== 'pending' || now >= q.deadlineAt) fail('QUESTION_DONE');
  if (typeof rawChoice !== 'number' || !Number.isInteger(rawChoice) || rawChoice < 0 || rawChoice >= q.options.length) {
    fail('CHOICE_INVALID');
  }

  const correct = rawChoice === q.answer;
  const delta = correct ? 2 : -1;
  answerer.score += delta;
  if (correct) answerer.correct += 1;
  answerer.answered += 1;
  q.status = 'answered';
  q.chosen = rawChoice;
  room.lastActivity = now;
  publish(pkChannel(room.roomId), {
    type: 'pk-verdict',
    roomId: room.roomId,
    questionId: q.id,
    byUserId: userId,
    correct,
    delta,
    score: answerer.score,
  });
  publishState(room);
  return { correct, delta, score: answerer.score };
}

/** 结算：分高者胜 → 平分比答对数 → 仍平为平局（契约 §1）。finished 后快照保留 10 分钟供回看。 */
export function settleRoom(room: Room, now = Date.now()): void {
  if (room.status !== 'active') return;
  const ranked = [...room.players].sort((a, b) => b.score - a.score || b.correct - a.correct);
  const top = ranked[0];
  const second = ranked[1];
  const tie = top !== undefined && second !== undefined && top.score === second.score && top.correct === second.correct;
  room.status = 'finished';
  if (!tie && top) room.winner = top.userId;
  room.aiBusy = false;
  room.lastActivity = now;
  publish(pkChannel(room.roomId), {
    type: 'pk-end',
    roomId: room.roomId,
    ...(room.winner ? { winner: room.winner } : {}),
    state: snapshotRoom(room),
  });
  stopTickerIfIdle();
}

/**
 * 1s ticker 的时间驱动逻辑（唯一入口，测试直接调）：
 * ① 对局时钟归零 → 结算；② 答题超时 → −1 并揭示答案；③ 怠慢窗口 → −1；
 * ④ PVE：AI CD 到点且不在途 → AI 出题（失败 10s 后重试，不扣分）。
 */
export function tickMatches(now = Date.now()): void {
  for (const room of allRoomsInternal()) {
    if (room.status !== 'active') continue;
    if (now >= room.endsAt) {
      settleRoom(room, now);
      continue;
    }
    let dirty = false;
    for (const q of room.questions) {
      if (q.status !== 'pending' || now < q.deadlineAt) continue;
      q.status = 'timeout';
      q.answerRevealed = q.answer;
      const answerer = memberOf(room, q.toUserId);
      if (answerer) {
        answerer.score -= 1;
        answerer.answered += 1;
        publish(pkChannel(room.roomId), {
          type: 'pk-verdict',
          roomId: room.roomId,
          questionId: q.id,
          byUserId: q.toUserId,
          correct: false,
          delta: -1,
          score: answerer.score,
        });
      }
      dirty = true;
    }
    for (const p of room.players) {
      const anchor = room.idleAnchor[p.userId] ?? room.startedAt;
      if (now - anchor < IDLE_PENALTY_MS) continue;
      room.idleAnchor[p.userId] = anchor + IDLE_PENALTY_MS;
      p.score -= 1;
      dirty = true;
    }
    if (dirty) {
      room.lastActivity = now;
      publishState(room);
    }
    if (room.mode === 'pve' && !room.aiBusy && now >= room.aiNextQuizAt) {
      room.aiBusy = true;
      void runAiQuiz(room.roomId).finally(() => {
        room.aiBusy = false;
      });
    }
  }
  stopTickerIfIdle();
}

/** AI 出题成功后由 ai-bot 回写下一题时刻（CD 同人）；失败走重试间隔 */
export function scheduleNextAiQuiz(room: Room, ok: boolean, now = Date.now()): void {
  room.aiNextQuizAt = now + (ok ? QUIZ_CD_MS : AI_RETRY_DELAY_MS);
}

// ── ticker 生命周期（真实服务用；测试用假时钟直接调 tickMatches，不 ensure）──

let ticker: ReturnType<typeof setInterval> | undefined;

export function ensureTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => tickMatches(Date.now()), 1000);
}

export function stopTickerIfIdle(): void {
  if (!ticker) return;
  const hasActive = allRoomsInternal().some((r) => r.status === 'active');
  if (!hasActive) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

/** 测试辅助：清 ticker（房间清空用例间隔离） */
export function resetMatchState(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = undefined;
  }
}
