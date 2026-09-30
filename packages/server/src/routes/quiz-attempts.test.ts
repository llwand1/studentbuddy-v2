/**
 * routes/quiz-attempts — `GET|POST /api/quiz/:quizId/attempts` 的 HTTP 层：入参闸门、归属隔离、没刷过是空 rows 不是 404。
 * 累计口径由 `shared/quiz-attempts.test` 与 `learning/quiz-attempts.test` 锁，这里只锁接口形状。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-qa-'));

const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

afterAll(() => closeDb());

const origin = 'http://localhost:5173';
async function signUp(email: string) {
  const user = await createUser(email, 'good-password-1', undefined);
  return { id: user.id, cookie: `${AUTH_COOKIE_NAME}=${issueSession(user.id).token}` };
}
const alice = await signUp('qa-alice@example.com');
const bob = await signUp('qa-bob@example.com');
const get = (url: string, cookie: string) => request(app).get(url).set('Origin', origin).set('Cookie', cookie);
const post = (url: string, cookie: string, body?: object) => request(app).post(url).set('Origin', origin).set('Cookie', cookie).send(body ?? {});
const QID = 'aaaaaaaa-1111-4222-8333-444444444444';

describe('GET|POST /api/quiz/:quizId/attempts', () => {
  it('没刷过 ⇒ 200 + 空 rows；记两笔后读回累计行；别人看不见', async () => {
    expect((await get(`/api/quiz/${QID}/attempts`, alice.cookie).expect(200)).body).toEqual({ quizId: QID, rows: [] });
    const first = await post(`/api/quiz/${QID}/attempts`, alice.cookie, { questionIndex: 0, verdict: 'correct', answer: 'A. 速度方向' }).expect(200);
    expect(first.body.row).toMatchObject({ index: 0, attempts: 1, correct: 1, streak: 1, last: { verdict: 'correct', answer: 'A. 速度方向' } });
    await post(`/api/quiz/${QID}/attempts`, alice.cookie, { questionIndex: 0, verdict: 'wrong', answer: 'B. 位移方向' }).expect(200);
    const rows = (await get(`/api/quiz/${QID}/attempts`, alice.cookie).expect(200)).body.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 2, correct: 1, streak: 0, bestStreak: 1, last: { verdict: 'wrong' } });
    expect((await get(`/api/quiz/${QID}/attempts`, bob.cookie).expect(200)).body.rows).toEqual([]);
  });

  it('★ 别人往我的题号上写 ⇒ 404（不是 403，不泄露 id 存在）；我的行原样', async () => {
    await post(`/api/quiz/${QID}/attempts`, bob.cookie, { questionIndex: 0, verdict: 'correct', answer: 'x' }).expect(404);
    const rows = (await get(`/api/quiz/${QID}/attempts`, alice.cookie).expect(200)).body.rows;
    expect(rows[0]).toMatchObject({ attempts: 2, last: { answer: 'B. 位移方向' } });
  });

  it('入参闸门：坏 quizId 400、坏题号/坏判定 400、answer 缺省为空串', async () => {
    await get('/api/quiz/%7B%22a%22%3A1%7D/attempts', alice.cookie).expect(400);
    await post(`/api/quiz/${QID}/attempts`, alice.cookie, { questionIndex: 'zero', verdict: 'correct' }).expect(400);
    await post(`/api/quiz/${QID}/attempts`, alice.cookie, { questionIndex: 1, verdict: 'right' }).expect(400);
    const ok = await post(`/api/quiz/${QID}/attempts`, alice.cookie, { questionIndex: 1, verdict: 'review' }).expect(200);
    expect(ok.body.row.last).toMatchObject({ verdict: 'review', answer: '' });
  });
});
