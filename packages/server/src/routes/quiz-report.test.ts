/**
 * routes/quiz-report —— `POST /api/quiz/report` 的端到端（issue #56，2026-09-27）。
 *
 * ★ 手法照 `cards.test.ts`：真 app + supertest + 两个真账号，**不 mock 归属**。
 *
 * 本文件只有一条是别处替代不了的，其余都是它的陪衬：
 *  ① **请求体里塞 `correct: true` 改变不了服务端的答案**。
 *     这条是"服务端复判"这条拍板的**唯一 HTTP 层兑现证据**——`shared/quiz-judge.test.ts`
 *     锁的是判分函数算得对，`learning/quiz-answer.test.ts` 锁的是域层只信自己算的那份，
 *     但「**线上格式根本没有给对错留位置**」这件事只有在路由上才量得出来。
 *     没有这条，将来谁加一个 `correct` 字段透传给域层，下面全部用例照样绿。
 *  ② 别人的卡与不存在的卡**响应体逐字相同**（不能变成一支探 UUID 的探针）；
 *  ③ 重答回 **200 + recorded:false**，不是 4xx——刷新重答是正常操作，报失败会误导用户；
 *  ④ 未登录（本地单人模式）这条路**必须通**：它占现网绝大多数请求，为它写特判的人多，
 *     把它测坏的人也有。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, type QuizQuestion } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-quiz-report-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { announceQuizToSession } = await import('../learning/quiz-announce.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches, createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

async function cookieFor(email: string): Promise<{ cookie: string; id: string }> {
  const user = await createUser(email, 'good-password-1', undefined);
  return { cookie: `${AUTH_COOKIE_NAME}=${issueSession(user.id).token}`, id: user.id };
}

const post = (body: unknown, cookie = '') => {
  const r = request(app).post('/api/quiz/report').set('Origin', origin).send(body as object);
  return cookie ? r.set('Cookie', cookie) : r;
};

const QS: QuizQuestion[] = [
  { type: 'single', question: '1+1=?', options: ['1', '2', '3'], answer: [1] },
  { type: 'essay', question: '为什么', answer: '要点', solution: '解答' },
];

/** 出一张卡进某个会话，返回前端会拿去上报的 quizId */
function announceInto(sessionId: string, quizId: string): string {
  announceQuizToSession(sessionId, { title: '路由测试', questions: QS }, quizId);
  return quizId;
}

function newSession(userId: string | null, id = `qr-sess-${Math.random().toString(36).slice(2, 8)}`): string {
  getDb().prepare('INSERT INTO sessions (id, title, user_id) VALUES (?, ?, ?)').run(id, '答题上报', userId);
  return id;
}

const logRows = (quizId: string) =>
  getDb().prepare('SELECT question_index, correct FROM quiz_answer_log WHERE quiz_id = ? ORDER BY rowid').all(quizId) as Array<{
    question_index: number;
    correct: number;
  }>;

let a: { cookie: string; id: string };
let b: { cookie: string; id: string };

beforeAll(async () => {
  a = await cookieFor('qr-a@example.com');
  b = await cookieFor('qr-b@example.com');
});
afterAll(() => {
  closeDb();
});
beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
  getDb().prepare('DELETE FROM quiz_answer_log').run();
  getDb().prepare('DELETE FROM quiz_block').run();
});

describe('正常链路与复判归属', () => {
  it('答对 ⇒ 200 { correct:true, recorded:true }，流水一行', async () => {
    const sid = newSession(a.id);
    const qid = announceInto(sid, 'qr-ok');
    const res = await post({ quizId: qid, index: 0, picked: [1] }, a.cookie).expect(200);
    expect(res.body).toEqual({ ok: true, correct: true, recorded: true });
    expect(logRows(qid)).toEqual([{ question_index: 0, correct: 1 }]);
  });

  it('★★ 请求体里塞 `correct:true` 改变不了答案 —— 判分归服务端就是这一条', async () => {
    const sid = newSession(a.id);
    const qid = announceInto(sid, 'qr-liar');
    // 明明勾了错的选项（正确答案是下标 1），却自称答对
    const res = await post({ quizId: qid, index: 0, picked: [0], correct: true }, a.cookie).expect(200);
    expect(res.body.correct).toBe(false);
    expect(logRows(qid)).toEqual([{ question_index: 0, correct: 0 }]);
  });

  it('未登录（本地单人模式，会话无主）⇒ 一样通，且记进无主行', async () => {
    const sid = newSession(null);
    const qid = announceInto(sid, 'qr-anon');
    const res = await post({ quizId: qid, index: 0, picked: [1] }).expect(200);
    expect(res.body).toMatchObject({ ok: true, correct: true, recorded: true });
    // 归属经会话带出来 ⇒ 无主会话里的作答落在"无主"这一档，与 ownerForWrite 口径一致
    expect(logRows(qid)).toHaveLength(1);
  });
});

describe('入参校验（400 的三种，与 404 分开）', () => {
  it('缺 quizId / index 不是非负整数 ⇒ 400', async () => {
    await post({ index: 0, picked: [1] }).expect(400);
    await post({ quizId: 'qr-x', index: -1, picked: [1] }).expect(400);
    await post({ quizId: 'qr-x', index: '0', picked: [1] }).expect(400);
    await post({ quizId: 'qr-x', picked: [1] }).expect(400);
  });

  it('题号越界 ⇒ 400，且**不是** 404（"这张卡不存在"与"这道题不在卡里"是两句话）', async () => {
    const sid = newSession(a.id);
    const qid = announceInto(sid, 'qr-oob');
    const res = await post({ quizId: qid, index: 9, picked: [1] }, a.cookie).expect(400);
    expect(res.body.error).toContain('题号');
    expect(logRows(qid)).toHaveLength(0);
  });
});

describe('不判与重答', () => {
  it('essay（免检）⇒ 200 { correct:null, recorded:false }，零流水', async () => {
    const sid = newSession(a.id);
    const qid = announceInto(sid, 'qr-essay');
    const res = await post({ quizId: qid, index: 1, text: '我写了一段' }, a.cookie).expect(200);
    expect(res.body).toEqual({ ok: true, correct: null, recorded: false });
    expect(logRows(qid)).toHaveLength(0);
  });

  it('重答同一题 ⇒ 200 而不是 4xx，`recorded:false`，首答的对错不被改写', async () => {
    const sid = newSession(a.id);
    const qid = announceInto(sid, 'qr-twice');
    await post({ quizId: qid, index: 0, picked: [1] }, a.cookie).expect(200);
    const res = await post({ quizId: qid, index: 0, picked: [0] }, a.cookie).expect(200);
    expect(res.body).toEqual({ ok: true, correct: false, recorded: false });
    expect(logRows(qid)).toEqual([{ question_index: 0, correct: 1 }]);
  });
});

describe('跨用户零串台', () => {
  it('B 报 A 的卡 ⇒ 404、A 的流水不增，且响应体与"卡根本不存在"逐字相同', async () => {
    const sid = newSession(a.id);
    const qid = announceInto(sid, 'qr-cross');
    const theirs = await post({ quizId: qid, index: 0, picked: [1] }, b.cookie).expect(404);
    const ghost = await post({ quizId: 'qr-no-such-card', index: 0, picked: [1] }, b.cookie).expect(404);
    // ★ 逐字相同：能分出"存在但不是你的"就等于给了一支猜 UUID 探别人的答题记录的探针
    expect(theirs.body).toEqual(ghost.body);
    expect(logRows(qid)).toHaveLength(0);
    // A 自己报同一张卡照旧通（排除"404 是因为链路上有别的问题"这种假绿）
    await post({ quizId: qid, index: 0, picked: [1] }, a.cookie).expect(200);
    expect(logRows(qid)).toHaveLength(1);
  });
});

describe('出题与上报的闭环（两条入口都要能记上账）', () => {
  it('聊天工具入口（`generate_quiz`）走的也是同一个门面 ⇒ 上报命中它的卡', async () => {
    // ★ 本批的原始症状之一就是"事件有声明、有消费者、零发布者"，而出题有 REST 与聊天工具
    //   两条入口。登记钥匙只挂在门面上 ⇒ 两条入口自动都通，这条就是那个"自动"的证据。
    const sid = newSession(a.id);
    const qid = announceInto(sid, 'qr-tool');
    const res = await post({ quizId: qid, index: 0, picked: [1] }, a.cookie).expect(200);
    expect(res.body.recorded).toBe(true);
  });

  it('刷新前的卡（live：只从 blockId 拿 id）与刷新后的卡（restore：从登记行拿 id）是同一把键', async () => {
    // 显式给 id 时登记行带 `quizId` 顶层键 ⇒ 还原路径反解出来的串与本条上报用的串一致。
    // 与 `packages/web/src/features/chat/chat-blocks.test.ts` 的 restore 用例是一把锁的两半。
    const sid = newSession(a.id);
    announceInto(sid, 'qr-restore');
    const row = getDb().prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get(sid) as {
      content: string;
    };
    const body = JSON.parse(row.content.slice('[QUIZ]'.length, -'[/QUIZ]'.length)) as { quizId?: string };
    expect(body.quizId).toBe('qr-restore');
    await post({ quizId: body.quizId, index: 0, picked: [1] }, a.cookie).expect(200);
  });
});
