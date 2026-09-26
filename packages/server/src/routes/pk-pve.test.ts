/**
 * routes/pk-pve — PVE 的 AI 对手（2026-09-12 老板拍板：AI 与人**完全同口径**答题 / 人机**对称**出题）。
 *
 * 钉四件事：
 * ① PVE 建房即占 AI 座位（ai-<roomId>），人再输码入房被满员挡下，房主可直接开局；
 * ② AI 出题由 1s ticker 到点触发（tickMatches 假时钟驱动），与人共用 pushGeneratedQuestion
 *    （+1 / 60s CD 同口径）；失败不扣分不占 CD，AI_RETRY_DELAY_MS(10s) 后重试；
 * ③ AI 答题走**独立** LLM 调用（routeRole('solver')，只喂题干+选项），判分与人同一 submitAnswer；
 * ④ 没配模型 → AI 不乱猜，题目超时由 ticker 同规则 −1——AI 没有特权。
 *
 * mock：generateQuiz 固定单选（答案下标 1）；routeRole 返回假目标（chat 流吐固定选项字母）。
 *
 * ★ B1（§14.1，2026-09-20）改写：HTTP 层身份换成统一账号 cookie 会话；域函数与 AI 链路不变。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import {
  AI_FIRST_QUIZ_DELAY_MS,
  AI_RETRY_DELAY_MS,
  AI_USER_PREFIX,
  ANSWER_TIME_MS,
  AUTH_COOKIE_NAME,
  PK_MATCH_MS,
  pkChannel,
  type PkRoomState,
  type QuizQuestion,
} from '@sb/shared';

vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateQuiz: vi.fn(),
}));
vi.mock('../llm/router.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  routeRole: vi.fn(),
}));

const { app, request, closeDb } = await boot('pk-pve-test', { requireAuth: true });
const origin = TEST_ORIGIN;

const { resetRooms, requireRoomInternal } = await import('../pk/room.js');
const { resetMatchState, submitQuiz, tickMatches } = await import('../pk/match.js');
const { PK_QUIZ_MIX } = await import('@sb/shared');
const { generateQuiz } = await import('../learning/quiz.js');
const { routeRole } = await import('../llm/router.js');
const { snapshot } = await import('../chat/sse-bus.js');

const post = (url: string, cookie?: string) => {
  const r = request(app).post(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};

/** 固定单选：正确答案下标 1（太平洋）——AI 答「B」即答对、答「A」即答错 */
const SINGLE: QuizQuestion = {
  type: 'single',
  question: '世界上最大的海洋是哪一个？',
  options: ['大西洋', '太平洋', '印度洋', '北冰洋'],
  answer: [1],
};

const events = (roomId: string) => snapshot(pkChannel(roomId));
/** 放行被 void 触发的异步流（runAiQuiz / runAiAnswer 都是火后不理，微任务+宏任务各让一步） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

function scoreOf(roomId: string, userId: string): number {
  const p = requireRoomInternal(roomId).players.find((x) => x.userId === userId);
  if (!p) throw new Error(`玩家 ${userId} 不在房内（测试前置失败）`);
  return p.score;
}

/** 假 LLM 目标：adapter.chat 流式吐一个固定字母（模拟模型作答） */
function fakeChatTarget(reply: string): ReturnType<typeof routeRole> {
  return {
    adapter: {
      chat: () =>
        (async function* () {
          yield { content: reply, done: true };
        })(),
    },
    model: 'mock-model',
  } as unknown as ReturnType<typeof routeRole>;
}

/** 建统一账号 + 取会话 cookie（同 pk-room.test.ts 手法） */
let userSeq = 0;
async function login(nickname: string): Promise<{ userId: string; nickname: string; cookie: string }> {
  const { createUser } = await import('../auth/users.js');
  const { createSession } = await import('../auth/session.js');
  const user = await createUser(`pk-pve-${++userSeq}@test.local`, 'good-password-1', nickname);
  const { token } = createSession(user.id);
  return { userId: user.id, nickname: user.nickname, cookie: `${AUTH_COOKIE_NAME}=${token}` };
}

/** 建 PVE 房（可选主题方向）并直接开局（AI 座位已占，无需等人） */
async function makePveRoom(aiTopic?: string) {
  const alice = await login('甲');
  // P0-7：人的主题建房时定；AI 座位开局时自动兜底（PK_DEFAULT_AI_TOPIC），不需要人替它填
  const body: Record<string, unknown> = { mode: 'pve', topic: '历史' };
  if (aiTopic) body.aiTopic = aiTopic;
  const created = await post('/api/pk/rooms', alice.cookie).send(body);
  expect(created.status).toBe(201);
  const { roomId, roomCode, state } = created.body as {
    roomId: string;
    roomCode: string;
    state: PkRoomState;
  };
  const started = await post(`/api/pk/rooms/${roomId}/start`, alice.cookie).send({});
  expect(started.status).toBe(200);
  const startedAt = (started.body as { state: PkRoomState }).state.endsAt - PK_MATCH_MS;
  return { alice, roomId, roomCode, state, startedAt, aiId: AI_USER_PREFIX + roomId };
}

beforeEach(() => {
  resetRooms();
  resetMatchState();
  vi.mocked(generateQuiz).mockResolvedValue({ questions: [SINGLE] });
  vi.mocked(routeRole).mockReturnValue(null); // 默认「没配模型」：AI 不作答
});

describe('PVE 建房与占座', () => {
  it('建房即占 AI 座位（ai-<roomId>），主题方向入库，人再输码入房 409，房主可直接开局', async () => {
    const { roomId, roomCode, state } = await makePveRoom('唐朝历史');
    expect(state.mode).toBe('pve');
    expect(state.aiTopic).toBe('唐朝历史');
    expect(state.players).toHaveLength(2);
    expect(state.players[1]?.userId).toBe(AI_USER_PREFIX + roomId);
    expect(state.players[1]?.nickname).toBe('AI 对手');
    const bob = await login('乙');
    expect((await post('/api/pk/rooms/join', bob.cookie).send({ roomCode })).status).toBe(409);
  });

  it('默认 mode=pvp：不建 AI 座位（回归防护）', async () => {
    const alice = await login('甲');
    const created = await post('/api/pk/rooms', alice.cookie).send({});
    const state = (created.body as { state: PkRoomState }).state;
    expect(state.mode).toBe('pvp');
    expect(state.players).toHaveLength(1);
  });
});

describe('AI 出题（ticker 到点触发，与人同口径）', () => {
  it('CD 到点自动出题：+1、题发给人、用指定主题、复用 PK 出题配比、下一题按 60s CD 排程', async () => {
    const { alice, roomId, startedAt, aiId } = await makePveRoom('世界历史');
    tickMatches(startedAt + AI_FIRST_QUIZ_DELAY_MS); // 假时钟推到 AI 首题时刻
    await flush();
    const room = requireRoomInternal(roomId);
    expect(room.questions).toHaveLength(1);
    const q = room.questions[0];
    if (!q) throw new Error('AI 未出题');
    expect(q.fromUserId).toBe(aiId);
    expect(q.toUserId).toBe(alice.userId);
    // P0-7：AI 同样遵守主题轮转——开局首轮是房主（甲）的主题「历史」，AI 出题也贴合它，不搞双重标准。
    // （建房填的 aiTopic 是 AI **自己**的主题，要等轮次切到 AI 那轮才会用到。）
    expect(q.prompt).toBe('主题：历史');
    expect(q.status).toBe('pending');
    expect(scoreOf(roomId, aiId)).toBe(1); // 出题 +1，与人一致
    // 末三参：report / styleArg 不传（AI 出题不需要出题报告与回答偏好），online=true
    // ——2026-09-13 老板拍板「PK 出题也接联网」，AI 与人同口径，两条路径都传 true
    // P0-7：首轮出题用「当前轮次主题」＝房主（甲）的主题，AI 与人同规则
    // ★ M2c 第 7 参 ownerId = **null（平台通道）**：AI 对手是平台扮演的角色、不是任何用户的请求，
    //   且一房两名玩家 ⇒ 不存在唯一 owner（契约 TENANCY-SPEC §8.1.4 后台路径表）。
    //   这笔钱明确记在平台上，受 §8.1.3.1 的两层并发闸门约束——不是"漏传"。
    expect(vi.mocked(generateQuiz)).toHaveBeenCalledWith('历史', undefined, PK_QUIZ_MIX, undefined, undefined, true, null);
    expect(room.aiBusy).toBe(false); // 在途结束
    const now = Date.now();
    expect(room.aiNextQuizAt).toBeLessThanOrEqual(now + 60_000);
    expect(room.aiNextQuizAt).toBeGreaterThan(now + 60_000 - 5000); // ≈ now + QUIZ_CD_MS
  });

  it('AI 出题失败：不扣分不占 CD，10s 后重试（AI_RETRY_DELAY_MS）', async () => {
    vi.mocked(generateQuiz).mockRejectedValueOnce(new Error('llm down'));
    const { roomId, startedAt, aiId } = await makePveRoom();
    tickMatches(startedAt + AI_FIRST_QUIZ_DELAY_MS);
    await flush();
    const room = requireRoomInternal(roomId);
    expect(room.questions).toHaveLength(0);
    expect(scoreOf(roomId, aiId)).toBe(0); // 失败不扣分
    expect(room.aiBusy).toBe(false);
    expect(room.aiNextQuizAt).toBeLessThanOrEqual(Date.now() + AI_RETRY_DELAY_MS + 1000);
  });
});

describe('AI 答题（与人完全同口径）', () => {
  it('模型答 B（正确）：AI +2、chosen 回填、verdict 广播 byUserId = AI 座位', async () => {
    vi.mocked(routeRole).mockReturnValue(fakeChatTarget('B'));
    const { alice, roomId, aiId } = await makePveRoom('科学');
    await submitQuiz(roomId, alice.userId, '最大的海洋', Date.now()); // 人出题 → 触发 runAiAnswer
    await flush();
    const room = requireRoomInternal(roomId);
    const q = room.questions[0];
    if (!q) throw new Error('missing');
    expect(q.status).toBe('answered');
    expect(q.chosen).toBe(1);
    expect(scoreOf(roomId, aiId)).toBe(2);
    const v = events(roomId).find((e) => e.type === 'pk-verdict');
    if (!v || v.type !== 'pk-verdict') throw new Error('pk-verdict 未广播');
    expect(v.byUserId).toBe(aiId);
    expect(v.correct).toBe(true);
    expect(v.delta).toBe(2);
  });

  it('模型答 A（错误）：AI 同样 −1，无特权', async () => {
    vi.mocked(routeRole).mockReturnValue(fakeChatTarget('A'));
    const { alice, roomId, aiId } = await makePveRoom();
    await submitQuiz(roomId, alice.userId, '最大的海洋', Date.now());
    await flush();
    const room = requireRoomInternal(roomId);
    expect(room.questions[0]?.chosen).toBe(0);
    expect(scoreOf(roomId, aiId)).toBe(-1);
  });

  it('没配模型：AI 不作答不乱猜，超时由 ticker 同规则 −1', async () => {
    const { alice, roomId, aiId } = await makePveRoom();
    const t0 = Date.now();
    await submitQuiz(roomId, alice.userId, '没人能答', t0);
    await flush();
    const room = requireRoomInternal(roomId);
    expect(room.questions[0]?.status).toBe('pending'); // AI 没答，题还挂着
    expect(scoreOf(roomId, aiId)).toBe(0);
    // 之后的 ticker 会触发 AI 出题（首题时刻已过）——让它失败，避免第二道题搅局
    vi.mocked(generateQuiz).mockRejectedValue(new Error('llm down'));
    tickMatches(t0 + ANSWER_TIME_MS + 1); // 同步断言，不 flush（AI 出题在途不插手）
    expect(scoreOf(roomId, aiId)).toBe(-1); // 超时判罚，与人同规则
    expect(room.questions[0]?.status).toBe('timeout');
  });
});

afterAll(() => {
  closeDb();
});
