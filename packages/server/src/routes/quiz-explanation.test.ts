import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';
const stub = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../learning/quiz-explanation.js', async (original) => ({
  ...await original<typeof import('../learning/quiz-explanation.js')>(), generateExplanation: stub.generate,
}));
process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-review-'));
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;
const user = await createUser('review-test@example.com', 'good-password-1', undefined);
const cookie = `${AUTH_COOKIE_NAME}=${createSession(user.id).token}`;
getDb().prepare('INSERT INTO sessions (id, title, user_id) VALUES (?, ?, ?)').run('owned', 'test', user.id);
getDb().prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('other', 'test');
const body = { sessionId: 'owned', title: '复盘', kind: 'quiz',
  items: [{ question: '为什么？', answer: '我的思路', expected: '参考思路', verdict: 'review', context: '' }] };
const post = (data: object = body) => request(app).post('/api/quiz/explain').set('Origin', 'http://localhost:5173').set('Cookie', cookie).send(data);
beforeEach(() => { stub.generate.mockReset(); stub.generate.mockResolvedValue({ summary: 'ok', sections: [], transfer: {} }); });
afterAll(closeDb);
describe('图文讲解路由', () => {
  it('真实会话与请求者传入引擎，不新增题库统计', async () => {
    await post().expect(200);
    expect(stub.generate).toHaveBeenCalledWith(body, user.id, expect.any(AbortSignal));
  });
  it('未知、他人、已删除会话均 404；不调用模型', async () => {
    await post({ ...body, sessionId: 'other' }).expect(404);
    await post({ ...body, sessionId: 'missing' }).expect(404);
    getDb().prepare("INSERT INTO sessions (id,title,user_id,deleted_at) VALUES ('gone','gone',?,datetime('now'))").run(user.id);
    await post({ ...body, sessionId: 'gone' }).expect(404);
    expect(stub.generate).not.toHaveBeenCalled();
  });
  it('空题组/异常输入 400；无 Origin 拒绝', async () => {
    await post({ ...body, items: [] }).expect(400);
    await post({ ...body, title: 1 }).expect(400);
    await request(app).post('/api/quiz/explain').set('Cookie', cookie).send(body).expect(403);
    expect(stub.generate).not.toHaveBeenCalled();
  });
  it('模型失败明确报错，释放占位后可以重试', async () => {
    stub.generate.mockRejectedValueOnce(new Error('没有完整图文'));
    const failed = await post().expect(502);
    expect(failed.body.error).toBe('没有完整图文');
    await post().expect(200);
  });
  it('同一请求者并发返回 409，不重复启动模型', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    stub.generate.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const first = post().then((r) => r);
    await vi.waitFor(() => expect(stub.generate).toHaveBeenCalledTimes(1));
    await post().expect(409);
    resolve({ summary: 'done', sections: [], transfer: {} });
    expect((await first).status).toBe(200);
    await post().expect(200);
  });
});
