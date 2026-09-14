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
  PK_QUIZ_MIX,
  QUIZ_CD_MS,
  QUIZ_FAIL_STRIKE,
  pkChannel,
  type PkRoomError,
  type PkRoomState,
} from '@sb/shared';
import type { PkQuestion, QuizPayload, QuizQuestion } from '@sb/shared';
import { publish } from '../chat/sse-bus.js';
import { generateQuiz } from '../learning/quiz.js';
import { allRoomsInternal, requireRoomInternal, snapshotRoom, type PkRoomQuestion, type Room } from './room.js';
import { runAiAnswer, runAiQuiz } from './ai-bot.js';
import { buildTopicAdvice, judgeTopicFit } from './judge.js';
import { settleRoom } from './settle.js';

/**
 * 域错误。`message` 仍是错误码本身（路由层据此查状态码，与既有写法兼容），
 * `extra` 是需要随错误一起回给前端的附加数据——典型是跑题时裁判给的建议：
 * 那种情况下「失败原因」和「怎么改」是一件事，塞进第二个字段比让前端再发一次请求合理。
 */
class PkFail extends Error {
  constructor(code: PkRoomError, readonly extra?: unknown) {
    super(code);
    this.name = 'PkFail';
  }
}

function fail(code: PkRoomError, extra?: unknown): never {
  throw new PkFail(code, extra);
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

/** QuizQuestion.answer（number|number[]|string…）→ 单选下标；不合法 → null。
 *  ★ 导出给 power.ts（二次机会的类似题也要走同一套合法性判定，避免两处各判一套） */
export function answerIndex(raw: unknown): number | null {
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
  topic?: string,
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
    ...(topic ? { topic } : {}),
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
  if (!room.currentTopic) fail('TOPIC_NOT_SET');
  const prompt = rawPrompt.trim().slice(0, PK_PROMPT_MAX);
  const topic = room.currentTopic;

  const prevCd = room.nextQuizAt[userId];
  if ((prevCd ?? 0) > now) fail('QUIZ_ON_COOLDOWN');
  room.nextQuizAt[userId] = now + QUIZ_CD_MS;
  author.lastQuizAt = now;
  room.idleAnchor[userId] = now;
  room.lastActivity = now;
  publishState(room);

  /** 回滚 CD：跑题与 AI 失败都不算「用掉了出题额度」——不回滚就等于罚人 60 秒，他不明白自己错在哪 */
  const rollbackCd = (): void => {
    if (prevCd === undefined) delete room.nextQuizAt[userId];
    else room.nextQuizAt[userId] = prevCd;
  };

  // 主题约束直接塞进出题提示词：先让模型「尽量出对」，再由裁判兜底判贴合度（两层，不单靠一层）
  let payload: QuizPayload | null = null;
  try {
    // 末参 online=true（2026-09-13 老板拍板）：PK 出题也走联网检索，出的题能是最新事实。
    payload = await generateQuiz(
      `${prompt}\n（硬约束：题目必须严格围绕主题「${topic}」，不得跑题）`,
      undefined,
      PK_QUIZ_MIX,
      undefined,
      undefined,
      true,
    );
  } catch {
    payload = null;
  }
  const generated = payload?.questions.find((x) => x.type === 'single');

  // ① 裁判判贴合度。★ 裁判不可用（null）时**按过处理**——ADR-4：旁挂能力挂了不能拖垮出题，
  //    否则「裁判模型没配」会让整局谁都出不了题，那比偶尔跑题严重得多。
  const fit = generated ? await judgeTopicFit(topic, prompt, String(generated.question)) : null;
  if (fit && !fit.fit) {
    author.failStreak += 1;
    const streak = author.failStreak;
    const struck = streak % QUIZ_FAIL_STRIKE === 0;
    if (struck) {
      author.score -= 1;
      author.failStreak = 0; // 扣完清零：下轮重新累计，不是「一辈子背着 3 次」
    }
    // ② 只有扣分时才让裁判出建议——每次跑题都调一次模型，既烧额度又把建议说廉价了
    const advice = struck ? await buildTopicAdvice(topic) : null;
    rollbackCd();
    room.lastActivity = now;
    publishState(room);
    fail('TOPIC_MISMATCH', {
      reason: fit.reason,
      failStreak: streak,
      penalty: struck ? -1 : 0,
      ...(advice ? { advice } : {}),
    });
  }

  const ok = pushGeneratedQuestion(room, userId, opponent.userId, prompt, generated, now, topic);
  if (!ok) {
    rollbackCd();
    publishState(room);
    fail('AI_GENERATION_FAILED');
  }
  // 成功出题：失败计数清零（已回到正轨）+ 当前主题切给对方（轮着来）
  author.failStreak = 0;
  advanceTopic(room);

  // PVE：这道题是发给 AI 的 → 立刻安排 AI 答题（异步，同人一条判分路径）
  if (room.mode === 'pve' && opponent.userId.startsWith('ai-')) {
    const q = room.questions[room.questions.length - 1];
    if (q) void runAiAnswer(room.roomId, q);
  }
  return snapshotRoom(room);
}

/** 内部题 → 对外载荷（answer 只在判定后以 answerRevealed 出现）。导出给 power.ts 复用 */
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
  if (q.chosen !== undefined) {
    base.chosen = q.chosen;
    base.answerRevealed = q.answer;
    return base;
  }
  if (q.status !== 'pending') base.answerRevealed = q.answer;
  return base;
}

/**
 * 主题轮转：成功出一道题后，当前主题切给**另一个玩家**。
 * ★ 只按 `topicOwnerId` 找下家、不按数组下标硬取——双方各有一个主题，
 *   交替的意义是「这轮归你的主题，下轮归我的」，下标法在 players 顺序变动时会错位。
 */
function advanceTopic(room: Room): void {
  const next = room.players.find((p) => p.userId !== room.topicOwnerId) ?? room.players[0];
  if (!next) return;
  room.topicOwnerId = next.userId;
  room.currentTopic = next.topic;
  room.topicTurn += 1;
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

/**
 * 结算与投降的**实现已搬到 `pk/settle.ts`**（P0-8，2026-09-14）。
 * 搬出理由：① 本文件当时 389/400 行，再往这里加收尾必撞 AGENTS 红线；
 * ② 路由层要能调 `forfeit`，不该 import 本文件的私有收尾。
 * 依赖方向单向：`match → settle`，`settle` **不**回头 import 本文件（不成环）。
 * ★ 兑现在 `settle.ts` 导出（`settleRoom`/`finishRoom`/`forfeitRoom`）——这里不再转出，
 *   免得同一函数有两个导出点（既有引用已核：`settleRoom` 只被本文件的 `tickMatches` 用）。
 */


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
