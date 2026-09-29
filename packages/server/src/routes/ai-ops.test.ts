/**
 * routes/ai-ops — `/api/ai/stats`、`/api/learning/*`、`/api/jobs*` 的**参数闸门与归属隔离**。
 * 汇总口径由 `ai/call-log.test`、`learning/learning-events.test` 锁，这里只锁 HTTP 层：
 *   ① 答题上报白名单 + 夹值 + 批量上限，全不合法才 400；② 上报真能经总线进汇总；
 *   ③ 看不到别人的调用/任务，重试别人的任务是 404 而不是 403（不泄露"这个 id 存在"）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-aiops-'));

const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const { wireLearningEvents } = await import('../learning/learning-events.js');
const { wireLlmCallLog } = await import('../ai/call-log.js');
const { reportLlmCall } = await import('../ai/gateway.js');
const q = await import('../jobs/queue.js');
const request = (await import('supertest')).default;

wireLearningEvents();
wireLlmCallLog();
afterAll(() => closeDb());

const origin = 'http://localhost:5173';
async function signUp(email: string) {
  const user = await createUser(email, 'good-password-1', undefined);
  return { id: user.id, cookie: `${AUTH_COOKIE_NAME}=${issueSession(user.id).token}` };
}
const alice = await signUp('aiops-alice@example.com');
const bob = await signUp('aiops-bob@example.com');

const get = (url: string, cookie: string) => request(app).get(url).set('Origin', origin).set('Cookie', cookie);
const post = (url: string, cookie: string, body?: object) => request(app).post(url).set('Origin', origin).set('Cookie', cookie).send(body ?? {});

describe('POST /api/learning/answers', () => {
  it('单条合法 ⇒ accepted=1，并进学习汇总', async () => {
    const res = await post('/api/learning/answers', alice.cookie, { correct: true, qtype: 'fill', ms: 3000, source: 'chat-quiz' }).expect(200);
    expect(res.body).toEqual({ accepted: 1 });
    const s = await get('/api/learning/summary?days=7', alice.cookie).expect(200);
    expect(s.body.totals).toMatchObject({ answers: 1, accuracy: 1 });
    const other = await get('/api/learning/summary?days=7', bob.cookie).expect(200);
    expect(other.body.totals.answers).toBe(0);
  });

  it('批量：不合法的丢弃、合法的收；题型/来源不在白名单就置空', async () => {
    const res = await post('/api/learning/answers', alice.cookie, {
      items: [{ correct: false, qtype: 'evil', source: 'x' }, { correct: 'yes' }, 'junk', { correct: true }],
    }).expect(200);
    expect(res.body.accepted).toBe(2);
  });

  it('全不合法 / 空 ⇒ 400；批量超 50 条只收前 50', async () => {
    await post('/api/learning/answers', alice.cookie, { correct: 'maybe' }).expect(400);
    await post('/api/learning/answers', alice.cookie, { items: [] }).expect(400);
    const many = Array.from({ length: 80 }, () => ({ correct: true }));
    expect((await post('/api/learning/answers', bob.cookie, { items: many }).expect(200)).body.accepted).toBe(50);
  });
});

describe('GET /api/ai/stats', () => {
  it('只看得到自己的调用；days 被夹在合理范围', async () => {
    reportLlmCall({ ownerId: alice.id, purpose: 'quiz.generate', role: 'quiz-generator', model: 'm', platform: false, status: 'ok', attempt: 1, latencyMs: 50 });
    reportLlmCall({ ownerId: bob.id, purpose: 'quiz.generate', role: 'quiz-generator', model: 'm', platform: false, status: 'timeout', attempt: 1, latencyMs: 9 });
    const a = await get('/api/ai/stats?days=9999', alice.cookie).expect(200);
    expect(a.body).toMatchObject({ calls: 1, ok: 1 });
    expect(a.body.days).toBeLessThanOrEqual(90);
    expect(a.body.recentFailures).toEqual([]);
  });
});

describe('/api/jobs', () => {
  it('列表带中文名与计数；只看得到自己的', async () => {
    const id = q.enqueueJob({ kind: 'chat.post_turn', ownerId: alice.id, payload: {} })!;
    q.failJob(q.claimJob()!, '上游挂了', true);
    const res = await get('/api/jobs', alice.cookie).expect(200);
    expect(res.body.counts.failed).toBe(1);
    expect(res.body.jobs[0]).toMatchObject({ id, label: '对话后抽词与记忆压缩', status: 'failed', lastError: '上游挂了' });
    expect((await get('/api/jobs', bob.cookie).expect(200)).body.jobs).toEqual([]);
  });

  it('★ 重试别人的任务 ⇒ 404；自己的 ⇒ 回到排队', async () => {
    const id = (await get('/api/jobs', alice.cookie)).body.jobs[0].id as string;
    await post(`/api/jobs/${id}/retry`, bob.cookie).expect(404);
    await post(`/api/jobs/${id}/retry`, alice.cookie).expect(200);
    await post(`/api/jobs/${id}/retry`, alice.cookie).expect(404); // 已不是失败态
  });
});
