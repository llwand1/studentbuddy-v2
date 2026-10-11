import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';
const stub = vi.hoisted(() => ({ predict: vi.fn(), adapt: vi.fn() }));
vi.mock('../learning/quiz-feedback.js', async original => ({ ...await original<typeof import('../learning/quiz-feedback.js')>(), predictFeedback: stub.predict, adaptQuestion: stub.adapt }));
process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-question-feedback-'));
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;
const user = await createUser('feedback-test@example.com', 'good-password-1', undefined);
const cookie = `${AUTH_COOKIE_NAME}=${createSession(user.id).token}`;
getDb().prepare('INSERT INTO sessions (id, title, user_id) VALUES (?, ?, ?)').run('owned', 'test', user.id);
getDb().prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('other', 'test');
const body = { title: '加法', sessionId: 'owned', question: { type: 'single', question: '2+3？', options: ['4', '5'], answer: [1] }, feedback: '简单一点', attempt: { answer: '4', verdict: 'wrong' } };
const quiz = { title: '基础加法', questions: [{ ...body.question, question: '1+1？', options: ['2', '3'], answer: [0] }], feedback: { comment: body.feedback, adjustment: '改为一步小数值运算' } };
const post = (kind: string, data: object = body) => request(app).post(`/api/quiz/feedback/${kind}`).set('Origin', 'http://localhost:5173').set('Cookie', cookie).send(data);
beforeEach(() => { stub.predict.mockReset().mockResolvedValue([]); stub.adapt.mockReset().mockResolvedValue(quiz); });
afterAll(closeDb);
describe('题目评价路由', () => {
  it('他人/不存在会话与无效输入不调用模型，Origin 仍受保护', async () => {
    await post('choices', { ...body, sessionId: 'other' }).expect(404);
    await post('adapt', { ...body, sessionId: 'missing' }).expect(404);
    await post('adapt', { ...body, feedback: '' }).expect(400);
    await post('choices', { ...body, attempt: undefined }).expect(400);
    await request(app).post('/api/quiz/feedback/adapt').set('Origin', 'https://evil.example').set('Cookie', cookie).send(body).expect(403);
    expect(stub.adapt).not.toHaveBeenCalled(); expect(stub.predict).not.toHaveBeenCalled();
  });
  it('预判只返回选项；新题随评价写入所属会话，历史可还原', async () => {
    const before = getDb().prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
    await post('choices').expect(200);
    expect((getDb().prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(before.n);
    const r = await post('adapt').expect(200);
    expect(r.body.announced).toBe(true);
    const row = getDb().prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get('owned') as { content: string };
    expect(row.content).toContain(r.body.quizId); expect(row.content).toContain('改为一步小数值运算');
    expect(stub.adapt).toHaveBeenCalledWith(body, user.id, expect.any(AbortSignal));
  });
  it('无会话的篝火题返回新卡而不写入任何会话', async () => {
    const { sessionId: _id, ...local } = body;
    const r = await post('adapt', local).expect(200); expect(r.body.announced).toBe(false);
  });
  it('同用户并发返回 409，失败后释放占位并允许重试', async () => {
    let resolve!: (value: typeof quiz) => void;
    stub.adapt.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const first = post('adapt').then(r => r);
    await vi.waitFor(() => expect(stub.adapt).toHaveBeenCalled());
    await post('choices').expect(409); resolve(quiz); await first;
    stub.adapt.mockRejectedValueOnce(new Error('模型失败')); await post('adapt').expect(502);
    await post('adapt').expect(200);
  });
  it('生成期间删除会话，不发布迟到题卡', async () => {
    getDb().prepare('INSERT INTO sessions (id, title, user_id) VALUES (?, ?, ?)').run('deleted', 'test', user.id);
    stub.adapt.mockImplementationOnce(async () => { getDb().prepare('DELETE FROM sessions WHERE id = ?').run('deleted'); return quiz; });
    await post('adapt', { ...body, sessionId: 'deleted' }).expect(404);
  });
});
