/**
 * routes/pk-scenario — §15.4 情景题进对战（B4，2026-09-20；契约 docs/PK-SPEC.md §15.4）。
 *
 * 钉的是 T5 全部四条：
 * ① criteria **不出现在任何对外载荷**（快照 + SSE 帧 + demo 页白名单行为）；
 * ② 全中 +2（且全中即提前结算）/ 有错 −1（含未上报的评分点算错）；
 * ③ 超时未上报算错（到点整页结算）；
 * ④ 二次机会候选过滤掉情景题。
 * 生成引擎 mock `streamScenarioDraft`（固定一套 2 评分点草稿）——只测计分与载荷纪律，不测生成质量。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import {
  ANSWER_TIME_MS,
  AUTH_COOKIE_NAME,
  PK_MATCH_MS,
  pkChannel,
  type PkRoomState,
  type ScenarioPayload,
} from '@sb/shared';

// 情景题生成整体 mock：对战计分测试不依赖真模型（learning/scenario.ts 其余导出原样保留）
vi.mock('../learning/scenario.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  streamScenarioDraft: vi.fn(),
}));
// 客观题管道同样 mock（兼容锁用例只断「被调用了」，不测生成质量）
vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateQuiz: vi.fn(),
}));

const { app, request, closeDb } = await boot('pk-scenario-test', { requireAuth: true });
const origin = TEST_ORIGIN;

const { resetRooms, requireRoomInternal } = await import('../pk/room.js');
const { resetMatchState, submitQuiz, tickMatches } = await import('../pk/match.js');
const { streamScenarioDraft } = await import('../learning/scenario.js');
const { requestRetry } = await import('../pk/power.js');
const { snapshot } = await import('../chat/sse-bus.js');

// 写操作过跨源闸门：模拟合法前端源（同 pk-match.test.ts）
const post = (url: string, cookie?: string) => {
  const r = request(app).post(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};
const get = (url: string, cookie?: string) => {
  const r = request(app).get(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};

/** 固定草稿：2 个评分点（state / choice 各一），criteria 形状走 SCENARIO-SPEC §1 */
const DRAFT: { payload: ScenarioPayload; html: string } = {
  payload: {
    title: '浮力小实验',
    tasks: [
      { id: 't1', prompt: '把铁块放进水里，观察沉浮', criteria: { kind: 'state', value: 'sink' } },
      { id: 't2', prompt: '选出会浮的材料', criteria: { kind: 'choice', answer: [1] } },
    ],
  },
  html: '<html><body><div id="demo">demo</div></body></html>',
};

const events = (roomId: string) => snapshot(pkChannel(roomId));

function qInternal(roomId: string, idx = 0) {
  const q = requireRoomInternal(roomId).questions[idx];
  if (!q) throw new Error(`题目 #${idx} 不存在（测试前置失败）`);
  return q;
}

function player(roomId: string, userId: string) {
  const p = requireRoomInternal(roomId).players.find((x) => x.userId === userId);
  if (!p) throw new Error(`玩家 ${userId} 不在房内（测试前置失败）`);
  return p;
}

let userSeq = 0;
async function login(nickname: string): Promise<{ userId: string; nickname: string; cookie: string }> {
  const { createUser } = await import('../auth/users.js');
  const { createSession } = await import('../auth/session.js');
  const user = await createUser(`pk-scen-${++userSeq}@test.local`, 'good-password-1', nickname);
  const { token } = createSession(user.id);
  return { userId: user.id, nickname: user.nickname, cookie: `${AUTH_COOKIE_NAME}=${token}` };
}

async function makeActiveRoom() {
  const alice = await login('甲');
  const bob = await login('乙');
  const created = await post('/api/pk/rooms', alice.cookie).send({ topic: '物理' });
  expect(created.status).toBe(201);
  const { roomId, roomCode } = created.body as { roomId: string; roomCode: string };
  expect((await post('/api/pk/rooms/join', bob.cookie).send({ roomCode })).status).toBe(200);
  expect((await post(`/api/pk/rooms/${roomId}/topic`, bob.cookie).send({ topic: '化学' })).status).toBe(200);
  const started = await post(`/api/pk/rooms/${roomId}/start`, alice.cookie).send({});
  expect(started.status).toBe(200);
  return { alice, bob, roomId, startedAt: (started.body as { state: PkRoomState }).state.endsAt - PK_MATCH_MS };
}

/** 以 t0 出一套情景题（甲出给乙） */
async function quizScenario(roomId: string, alice: { userId: string }, t0: number): Promise<void> {
  const state = await submitQuiz(roomId, alice.userId, '出一套浮力情景题', t0, null, 'scenario');
  expect(state.questions).toHaveLength(1);
}

beforeEach(() => {
  resetRooms();
  resetMatchState();
  vi.mocked(streamScenarioDraft).mockReset();
  vi.mocked(streamScenarioDraft).mockResolvedValue(DRAFT);
});

describe('§15.4 T5-① criteria 不出现在任何对外载荷', () => {
  it('快照题：kind=scenario、tasks 只有 id/prompt/hint；answer/answerRevealed/criteria/scenarioInternal 全无', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    const snap = (await import('../pk/snapshot.js')).snapshotRoom(requireRoomInternal(roomId));
    const sq = snap.questions[0];
    if (!sq || sq.kind !== 'scenario' || !sq.scenario) throw new Error('情景题未按 kind=scenario 入快照');
    expect(sq.stem).toBe(DRAFT.payload.title);
    expect(sq.options).toEqual([]);
    expect(sq.scenario.demoId).toBe(qInternal(roomId).scenarioInternal?.demoId);
    expect(sq.scenario.tasks).toEqual([
      { id: 't1', prompt: DRAFT.payload.tasks[0]?.prompt },
      { id: 't2', prompt: DRAFT.payload.tasks[1]?.prompt },
    ]);
    expect(sq).not.toHaveProperty('answer');
    expect(sq).not.toHaveProperty('answerRevealed');
    expect(sq).not.toHaveProperty('chosen');
    // 结构性外泄锁：整份快照序列化后不允许出现 criteria / 内部字段（demo 源码也不在库不在快照）
    const raw = JSON.stringify(snap);
    expect(raw).not.toContain('criteria');
    expect(raw).not.toContain('scenarioInternal');
    expect(player(roomId, alice.userId).score).toBe(1);
    expect(sq.deadlineAt).toBe(t0 + ANSWER_TIME_MS);
    void bob;
  });

  it('SSE pk-question / pk-state 帧同样不漏 criteria（对外载荷纪律含广播通道）', async () => {
    const t0 = Date.now();
    const { alice, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    const qev = events(roomId).find((e) => e.type === 'pk-question');
    if (!qev || qev.type !== 'pk-question') throw new Error('pk-question 未广播');
    const raw = JSON.stringify(events(roomId));
    expect(raw).not.toContain('criteria');
    expect(raw).not.toContain('scenarioInternal');
    void qev;
  });
});

describe('§15.4 T5-② 全中 +2（提前结算）/ 有错 −1', () => {
  it('两个评分点依次判对 → 第二次上报后立即结算 +2（不等 45s），pk-verdict 广播', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    const report = (taskId: string, observed: unknown) =>
      post(`/api/pk/rooms/${roomId}/scenario-report`, bob.cookie).send({
        questionId: qInternal(roomId).id,
        taskId,
        observed,
      });
    expect((await report('t1', 'sink')).status).toBe(200); // 乙 score 仍 0：有全中前不结算
    expect(player(roomId, bob.userId).score).toBe(0);
    expect(qInternal(roomId).status).toBe('pending');
    const ok2 = await report('t2', [1]);
    expect(ok2.status).toBe(200);
    expect((ok2.body as { correct: boolean }).correct).toBe(true);
    expect(player(roomId, bob.userId).score).toBe(2);
    expect(player(roomId, bob.userId).correct).toBe(1);
    expect(player(roomId, bob.userId).answered).toBe(1);
    expect(qInternal(roomId).status).toBe('answered');
    expect(qInternal(roomId).taskResults).toEqual({ t1: true, t2: true });
    const v = events(roomId).find((e) => e.type === 'pk-verdict');
    if (!v || v.type !== 'pk-verdict') throw new Error('pk-verdict 未广播');
    expect(v.correct).toBe(true);
    expect(v.delta).toBe(2);
    expect(v.byUserId).toBe(bob.userId);
    void alice;
  });

  it('判错不结算；重报以最后一次为准（demo 允许改正）', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    const report = (taskId: string, observed: unknown) =>
      post(`/api/pk/rooms/${roomId}/scenario-report`, bob.cookie).send({
        questionId: qInternal(roomId).id,
        taskId,
        observed,
      });
    const wrong = await report('t1', 'float');
    expect((wrong.body as { correct: boolean }).correct).toBe(false);
    expect(qInternal(roomId).status).toBe('pending'); // 有错不结算：还能改
    expect((await report('t2', [1])).status).toBe(200); // t2 对但 t1 错 → 不满足全中
    expect(qInternal(roomId).status).toBe('pending');
    expect((await report('t1', 'sink')).body as { correct: boolean }).toEqual({ correct: true }); // 改正
    expect(player(roomId, bob.userId).score).toBe(2); // 全中 → 提前结算
    void alice;
  });

  it('判分只认服务端：demo 上报垃圾 observed 一律判错（judgeTask 口径）', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    const r = await post(`/api/pk/rooms/${roomId}/scenario-report`, bob.cookie).send({
      questionId: qInternal(roomId).id,
      taskId: 't2',
      observed: 'hack', // 非法形状 → judgeTask 判错，不抛错
    });
    expect((r.body as { correct: boolean }).correct).toBe(false);
    void alice;
  });
});

describe('§15.4 T5-③ 超时未上报算错（到点整页结算 −1）', () => {
  it('只报对一个评分点就放着 → 到点 −1、status=timeout、correct 不加', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    await post(`/api/pk/rooms/${roomId}/scenario-report`, bob.cookie).send({
      questionId: qInternal(roomId).id,
      taskId: 't1',
      observed: 'sink',
    });
    tickMatches(t0 + ANSWER_TIME_MS);
    expect(player(roomId, bob.userId).score).toBe(-1);
    expect(player(roomId, bob.userId).answered).toBe(1);
    expect(player(roomId, bob.userId).correct).toBe(0);
    expect(qInternal(roomId).status).toBe('timeout');
    const v = events(roomId).find((e) => e.type === 'pk-verdict');
    if (!v || v.type !== 'pk-verdict') throw new Error('pk-verdict 未广播');
    expect(v.delta).toBe(-1);
  });

  it('一个都没上报 → 到点同样 −1（未上报的评分点算错）', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    tickMatches(t0 + ANSWER_TIME_MS);
    expect(player(roomId, bob.userId).score).toBe(-1);
    expect(qInternal(roomId).status).toBe('timeout');
    expect(qInternal(roomId).taskResults).toBeUndefined();
  });
});

describe('§15.4 守卫与白名单', () => {
  it('task 白名单外 → 400 SCENARIO_TASK_INVALID；不是你的题 → 403；局外人 → 403；结算后 → 409', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    const report = (cookie: string, body: Record<string, unknown>) =>
      post(`/api/pk/rooms/${roomId}/scenario-report`, cookie).send({ questionId: qInternal(roomId).id, ...body });
    const loner = await login('局外人');
    expect((await report(bob.cookie, { taskId: 'evil', observed: 1 })).status).toBe(400);
    const bad = await report(bob.cookie, { taskId: 'ghost', observed: 1 });
    expect(bad.status).toBe(400);
    expect((bad.body as { code: string }).code).toBe('SCENARIO_TASK_INVALID');
    expect((await report(alice.cookie, { taskId: 't1', observed: 'sink' })).status).toBe(403); // 出题人不是答题人
    expect((await report(loner.cookie, { taskId: 't1', observed: 'sink' })).status).toBe(403);
    await report(bob.cookie, { taskId: 't1', observed: 'sink' });
    await report(bob.cookie, { taskId: 't2', observed: [1] }); // 全中 → 已结算
    expect((await report(bob.cookie, { taskId: 't1', observed: 'sink' })).status).toBe(409);
  });

  it('客观题答题端点打情景题 → 400 CHOICE_INVALID（无选项可交）', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    const r = await post(`/api/pk/rooms/${roomId}/answer`, bob.cookie).send({
      questionId: qInternal(roomId).id,
      choice: 0,
    });
    expect(r.status).toBe(400);
  });
});

describe('§15.4 demo 页（房内成员授权）', () => {
  it('答题方可取（含桥接脚本）；局外人 404；未登录 401', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    const demoId = qInternal(roomId).scenarioInternal?.demoId;
    if (!demoId) throw new Error('demoId 缺失（测试前置失败）');
    const url = `/api/pk/rooms/${roomId}/scenario/${demoId}`;
    const ok = await get(url, bob.cookie);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('SBScenario');
    expect(ok.text).toContain(demoId);
    expect(ok.text).toContain('demo');
    const loner = await login('局外人');
    expect((await get(url, loner.cookie)).status).toBe(404);
    expect((await get(url)).status).toBe(401);
    void alice;
  });
});

describe('§15.4 T5-④ 二次机会候选过滤情景题', () => {
  it('情景题 id 打 requestRetry → RETRY_NO_TARGET（服务端同拒，不只靠前端过滤）', async () => {
    const t0 = Date.now();
    const { alice, bob, roomId } = await makeActiveRoom();
    await quizScenario(roomId, alice, t0);
    tickMatches(t0 + ANSWER_TIME_MS); // 到点判罚成「错题」
    await expect(requestRetry(roomId, bob.userId, qInternal(roomId).id, t0 + ANSWER_TIME_MS + 1)).rejects.toThrow(
      'RETRY_NO_TARGET',
    );
  });
});

describe('§15.4 生成失败与向后兼容', () => {
  it('生成失败 → 502 AI_GENERATION_FAILED 且 CD 回滚（免费重试立即成功）', async () => {
    const { alice, roomId } = await makeActiveRoom();
    vi.mocked(streamScenarioDraft).mockResolvedValueOnce(null); // 没配模型 / 解析失败
    const failed = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({ prompt: '会失败的情景题', qKind: 'scenario' });
    expect(failed.status).toBe(502);
    expect((failed.body as { code: string }).code).toBe('AI_GENERATION_FAILED');
    const retry = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({ prompt: '重试', qKind: 'scenario' });
    expect(retry.status).toBe(200);
    expect((retry.body as { state: PkRoomState }).state.questions).toHaveLength(1);
  });

  it('缺省 qKind 走客观题管道（generateQuiz 被调，情景引擎不被调）——旧前端零改动锁', async () => {
    const t0 = Date.now();
    const { alice, roomId } = await makeActiveRoom();
    const { generateQuiz } = await import('../learning/quiz.js');
    vi.mocked(generateQuiz).mockResolvedValue({
      questions: [{ type: 'single', question: '世界上最大的海洋是哪一个？', options: ['大西洋', '太平洋', '印度洋', '北冰洋'], answer: [1] }],
    });
    const ok = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({ prompt: '普通单选' });
    expect(ok.status).toBe(200);
    expect(vi.mocked(generateQuiz).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(streamScenarioDraft).mock.calls.length).toBe(0);
    void t0;
  });
});

afterAll(() => {
  closeDb();
});
