/**
 * routes/pk-power — P0-7：主题轮转 / 出题跑题校验 / 求助道具 / 错题二次机会。
 *
 * 钉七件事（都是老板口述规则的可回归判据）：
 * ① 开局首轮主题 = 房主主题；每**成功**出一道题切给对方（轮着来）
 * ② 裁判判跑题 → 422、失败计数 +1、**CD 回滚**（能立刻改提示词重试）
 * ③ 累计满 `QUIZ_FAIL_STRIKE` 次跑题 → −1 分，且裁判建议随错误回传（`extra.advice`）
 * ④ **裁判不可用时出题照过**——旁挂能力不拖垮主路径（ADR-4），否则裁判没配模型就整局出不了题
 * ⑤ 有人没选主题就开局 → 409 TOPIC_NOT_SET
 * ⑥ 求助道具每局 1 个：用后归零，再用 → 409 HELP_EXHAUSTED
 * ⑦ 二次机会：错题给解析 + 建类似题（发给本人、标记 isRetry）；CD 内再请求 → 429；答对的题 → 404
 *
 * mock：generateQuiz 固定单选（正确答案下标 0）；judge 四个能力全 mock——
 * 测的是**判罚与状态流转**，不是模型输出质量。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QUIZ_FAIL_STRIKE, type PkJudgeAdvice, type QuizQuestion } from '@sb/shared';

vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateQuiz: vi.fn(),
}));

// 裁判整模块 mock：四个能力都是外部调用，本文件只测「拿到裁判结论之后怎么判罚」
vi.mock('../pk/judge.js', () => ({
  judgeTopicFit: vi.fn(),
  buildTopicAdvice: vi.fn(),
  helpWithQuestion: vi.fn(),
  explainAndRetry: vi.fn(),
}));

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pk-power-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { resetRooms, requireRoomInternal } = await import('../pk/room.js');
const { resetMatchState } = await import('../pk/match.js');
const { generateQuiz } = await import('../learning/quiz.js');
const { judgeTopicFit, buildTopicAdvice, helpWithQuestion, explainAndRetry } = await import('../pk/judge.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const post = (url: string) => request(app).post(url).set('Origin', origin);

/** 固定单选：正确答案下标 0（青海） */
const SINGLE: QuizQuestion = {
  type: 'single',
  question: '长江发源于哪个省？',
  options: ['青海', '四川', '西藏', '云南'],
  answer: [0],
};

const ADVICE: PkJudgeAdvice = {
  advice: ['出一问「某某事件的时间」', '出一问「某某制度的成因」'],
  knowledge: '该主题的核心知识点（mock）',
  refs: [{ n: 1, title: '参考资料', url: 'https://example.com/a', provider: 'exa' }],
};

async function login(nickname: string): Promise<{ userId: string }> {
  const r = await post('/api/pk/auth/login').send({ nickname });
  return r.body as { userId: string };
}

/** 建一间双方都已选定主题并已开局的房（甲主题「历史」、乙主题「地理」） */
async function makeActiveRoom(): Promise<{ alice: { userId: string }; bob: { userId: string }; roomId: string }> {
  const alice = await login('甲');
  const bob = await login('乙');
  const created = await post('/api/pk/rooms').send({ userId: alice.userId, topic: '历史' });
  const { roomId, roomCode } = created.body as { roomId: string; roomCode: string };
  await post('/api/pk/rooms/join').send({ roomCode, userId: bob.userId });
  await post(`/api/pk/rooms/${roomId}/topic`).send({ userId: bob.userId, topic: '地理' });
  const started = await post(`/api/pk/rooms/${roomId}/start`).send({ userId: alice.userId });
  expect(started.status).toBe(200);
  return { alice, bob, roomId };
}

function scoreOf(roomId: string, userId: string): number {
  return requireRoomInternal(roomId).players.find((p) => p.userId === userId)?.score ?? 0;
}

function streakOf(roomId: string, userId: string): number {
  return requireRoomInternal(roomId).players.find((p) => p.userId === userId)?.failStreak ?? -1;
}

function firstQuestionId(roomId: string): string {
  const q = requireRoomInternal(roomId).questions[0];
  if (!q) throw new Error('题目不存在（测试前置失败）');
  return q.id;
}

beforeEach(() => {
  resetRooms();
  resetMatchState();
  vi.mocked(generateQuiz).mockResolvedValue({ questions: [SINGLE] });
  // 默认「贴合主题」：只有显式改成 fit:false 的用例才走跑题分支
  vi.mocked(judgeTopicFit).mockResolvedValue({ fit: true, reason: '' });
  vi.mocked(buildTopicAdvice).mockResolvedValue(ADVICE);
});

describe('① 主题轮转（谁出题都要贴合当前主题）', () => {
  it('开局首轮主题 = 房主主题', async () => {
    const { alice, roomId } = await makeActiveRoom();
    const room = requireRoomInternal(roomId);
    expect(room.currentTopic).toBe('历史');
    expect(room.topicOwnerId).toBe(alice.userId);
    expect(room.topicTurn).toBe(0);
  });

  it('成功出一道题后，主题切给对方（轮着来）', async () => {
    const { alice, roomId } = await makeActiveRoom();
    const r = await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: alice.userId, prompt: '出一道朝代题' });
    expect(r.status).toBe(200);
    const room = requireRoomInternal(roomId);
    expect(room.currentTopic).toBe('地理');
    expect(room.topicOwnerId).not.toBe(alice.userId);
    expect(room.topicTurn).toBe(1);
    // 题上要记下出题时属于哪一题主题，回看与判跑题都靠它
    expect(room.questions[0]?.topic).toBe('历史');
  });
});

describe('② 出题跑题的判罚', () => {
  it('裁判判跑题 → 422、失败计数 +1、CD 回滚（可立刻改提示词重试）', async () => {
    const { alice, roomId } = await makeActiveRoom();
    vi.mocked(judgeTopicFit).mockResolvedValue({ fit: false, reason: '这题属于地理不是历史' });

    const r = await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: alice.userId, prompt: '出一道气候题' });
    expect(r.status).toBe(422);
    const body = r.body as { code: string; extra?: { reason?: string } };
    expect(body.code).toBe('TOPIC_MISMATCH');
    expect(body.extra?.reason).toBe('这题属于地理不是历史');

    const room = requireRoomInternal(roomId);
    expect(room.questions).toHaveLength(0); // 跑题的题不进对局
    expect(streakOf(roomId, alice.userId)).toBe(1);
    expect(scoreOf(roomId, alice.userId)).toBe(0); // 未满 3 次不扣分

    // CD 已回滚 ⇒ 立刻重试不该撞 429（跑题不是「用掉了出题额度」）
    vi.mocked(judgeTopicFit).mockResolvedValue({ fit: true, reason: '' });
    const again = await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: alice.userId, prompt: '出一道朝代题' });
    expect(again.status).toBe(200);
    expect(streakOf(roomId, alice.userId)).toBe(0); // 成功后计数清零
  });

  it(`累计满 ${QUIZ_FAIL_STRIKE} 次跑题 → −1 分，并把裁判建议随错误回传`, async () => {
    const { alice, roomId } = await makeActiveRoom();
    vi.mocked(judgeTopicFit).mockResolvedValue({ fit: false, reason: '跑题' });

    let last: { status: number; body: { extra?: { advice?: PkJudgeAdvice; penalty?: number } } } | undefined;
    for (let i = 1; i <= QUIZ_FAIL_STRIKE; i += 1) {
      last = await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: alice.userId, prompt: `第 ${i} 次` });
      expect(last.status).toBe(422);
      // 前两次还没到阈值，不该带建议（每次跑题都调模型，既烧额度又把建议说廉价）
      if (i < QUIZ_FAIL_STRIKE) expect(last.body.extra?.advice).toBeUndefined();
    }
    expect(scoreOf(roomId, alice.userId)).toBe(-1);
    expect(last?.body.extra?.penalty).toBe(-1);
    expect(last?.body.extra?.advice).toEqual(ADVICE);
    expect(streakOf(roomId, alice.userId)).toBe(0); // 扣完清零，下轮重新累计
  });

  it('裁判不可用（judge 返 null）→ 出题照过，不拖垮主路径（ADR-4）', async () => {
    const { alice, roomId } = await makeActiveRoom();
    vi.mocked(judgeTopicFit).mockResolvedValue(null);
    const r = await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: alice.userId, prompt: '出一道题' });
    expect(r.status).toBe(200);
    expect(requireRoomInternal(roomId).questions).toHaveLength(1);
  });
});

describe('③ 开局前的主题闸门', () => {
  it('有人没选主题就开局 → 409 TOPIC_NOT_SET', async () => {
    const alice = await login('甲');
    const bob = await login('乙');
    const created = await post('/api/pk/rooms').send({ userId: alice.userId, topic: '历史' });
    const { roomId, roomCode } = created.body as { roomId: string; roomCode: string };
    await post('/api/pk/rooms/join').send({ roomCode, userId: bob.userId });

    const r = await post(`/api/pk/rooms/${roomId}/start`).send({ userId: alice.userId });
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe('TOPIC_NOT_SET');
  });
});

describe('④ 求助道具（每局 1 个）', () => {
  it('用后 helpLeft 归零，再用 → 409 HELP_EXHAUSTED', async () => {
    const { alice, roomId } = await makeActiveRoom();
    await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: alice.userId, prompt: '出一道朝代题' });
    const qid = firstQuestionId(roomId);
    vi.mocked(helpWithQuestion).mockResolvedValue(ADVICE);

    const first = await post(`/api/pk/rooms/${roomId}/help`).send({ userId: alice.userId, questionId: qid });
    expect(first.status).toBe(200);
    expect((first.body as { advice: PkJudgeAdvice }).advice).toEqual(ADVICE);
    expect(requireRoomInternal(roomId).players.find((p) => p.userId === alice.userId)?.helpLeft).toBe(0);

    const second = await post(`/api/pk/rooms/${roomId}/help`).send({ userId: alice.userId, questionId: qid });
    expect(second.status).toBe(409);
    expect((second.body as { code: string }).code).toBe('HELP_EXHAUSTED');
  });

  it('裁判不可用 → 502 JUDGE_UNAVAILABLE，且道具**不被扣**', async () => {
    const { alice, roomId } = await makeActiveRoom();
    await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: alice.userId, prompt: '出一道朝代题' });
    vi.mocked(helpWithQuestion).mockResolvedValue(null);

    const r = await post(`/api/pk/rooms/${roomId}/help`).send({ userId: alice.userId, questionId: firstQuestionId(roomId) });
    expect(r.status).toBe(502);
    expect((r.body as { code: string }).code).toBe('JUDGE_UNAVAILABLE');
    // ★ 关键：没拿到东西就得没花代价，否则玩家平白损失唯一的道具
    expect(requireRoomInternal(roomId).players.find((p) => p.userId === alice.userId)?.helpLeft).toBe(1);
  });
});

describe('⑤ 错题二次机会', () => {
  /** 让 alice 手上有一道自己答错的题（bob 出题 → alice 选错） */
  async function withWrongAnswer(roomId: string, bob: { userId: string }, alice: { userId: string }): Promise<string> {
    await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: bob.userId, prompt: '出一道题' });
    const qid = firstQuestionId(roomId);
    await post(`/api/pk/rooms/${roomId}/answer`).send({ userId: alice.userId, questionId: qid, choice: 1 }); // 正确答案是 0
    return qid;
  }

  it('错题 → 给解析 + 建类似题（发给本人、标记 isRetry）；CD 内再请求 → 429', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    const qid = await withWrongAnswer(roomId, bob, alice);
    vi.mocked(explainAndRetry).mockResolvedValue({ explanation: '长江发源于青海', generated: SINGLE });

    const r = await post(`/api/pk/rooms/${roomId}/retry`).send({ userId: alice.userId, questionId: qid });
    expect(r.status).toBe(200);
    const body = r.body as {
      explanation: string;
      question: { isRetry?: boolean; toUserId: string; retryOf?: string } | null;
    };
    expect(body.explanation).toBe('长江发源于青海');
    expect(body.question?.isRetry).toBe(true);
    expect(body.question?.toUserId).toBe(alice.userId);
    expect(body.question?.retryOf).toBe(qid);

    const again = await post(`/api/pk/rooms/${roomId}/retry`).send({ userId: alice.userId, questionId: qid });
    expect(again.status).toBe(429);
    expect((again.body as { code: string }).code).toBe('RETRY_ON_COOLDOWN');
  });

  it('类似题答对 +2（原错题的 −1 不撤销，净 +1）', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    const qid = await withWrongAnswer(roomId, bob, alice);
    vi.mocked(explainAndRetry).mockResolvedValue({ explanation: '解析', generated: SINGLE });
    const retried = await post(`/api/pk/rooms/${roomId}/retry`).send({ userId: alice.userId, questionId: qid });
    const newQid = (retried.body as { question: { id: string } }).question.id;

    const before = scoreOf(roomId, alice.userId);
    const r = await post(`/api/pk/rooms/${roomId}/answer`).send({ userId: alice.userId, questionId: newQid, choice: 0 });
    expect(r.status).toBe(200);
    expect((r.body as { correct: boolean; delta: number }).correct).toBe(true);
    expect((r.body as { delta: number }).delta).toBe(2);
    // 答错那次 −1 已记在 before 里，这里只验证补救确实加了 2
    expect(scoreOf(roomId, alice.userId)).toBe(before + 2);
  });

  it('答对的题不给二次机会 → 404 RETRY_NO_TARGET', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    await post(`/api/pk/rooms/${roomId}/quiz`).send({ userId: bob.userId, prompt: '出一道题' });
    const qid = firstQuestionId(roomId);
    await post(`/api/pk/rooms/${roomId}/answer`).send({ userId: alice.userId, questionId: qid, choice: 0 }); // 答对

    const r = await post(`/api/pk/rooms/${roomId}/retry`).send({ userId: alice.userId, questionId: qid });
    expect(r.status).toBe(404);
    expect((r.body as { code: string }).code).toBe('RETRY_NO_TARGET');
  });
});

afterAll(() => {
  closeDb();
});
