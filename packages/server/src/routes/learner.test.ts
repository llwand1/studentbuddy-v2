/**
 * routes/learner — `/api/learning/grade|model|misconceptions` 的 HTTP 层：入参闸门、失败状态码、归属。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-learner-'));

const grade = vi.hoisted(() => ({ out: { ok: true, result: { verdict: 'partial', score: 0.5, feedback: '差一点', misconception: 'x' } } as unknown }));
vi.mock('../learning/quiz-grade.js', () => ({ gradeAnswer: async () => grade.out }));

const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');
const { recordMisconception } = await import('../learning/learner-model.js');
const { parseGradeRequest } = await import('./learner.js');
const request = (await import('supertest')).default;
afterAll(() => closeDb());

const origin = 'http://localhost:5173';
async function signUp(email: string) {
  const u = await createUser(email, 'good-password-1', undefined);
  return { id: u.id, cookie: `${AUTH_COOKIE_NAME}=${createSession(u.id).token}` };
}
const alice = await signUp('learner-alice@example.com');
const bob = await signUp('learner-bob@example.com');
const post = (url: string, cookie: string, body: object = {}) => request(app).post(url).set('Origin', origin).set('Cookie', cookie).send(body);
const body = { question: '题', reference: '参考', answer: '作答', qtype: 'essay' };

describe('parseGradeRequest', () => {
  it('必填三段非空、题型只认 fill/essay、超长拒收；可选字段合法才带上', () => {
    expect(parseGradeRequest(body)).toEqual(body);
    expect(parseGradeRequest({ ...body, qtype: 'single' })).toBeNull();
    expect(parseGradeRequest({ ...body, answer: '  ' })).toBeNull();
    expect(parseGradeRequest({ ...body, answer: 'x'.repeat(4001) })).toBeNull();
    expect(parseGradeRequest({ ...body, termId: 't', topic: 7 })).toEqual({ ...body, termId: 't' });
    expect(parseGradeRequest(null)).toBeNull();
  });
});

describe('POST /api/learning/grade', () => {
  it('成功回 GradeResult；坏入参 400', async () => {
    const r = await post('/api/learning/grade', alice.cookie, body).expect(200);
    expect(r.body.verdict).toBe('partial');
    await post('/api/learning/grade', alice.cookie, { ...body, qtype: 'x' }).expect(400);
  });
  it('★ 没配模型 503、超时 504、其他 502，且带 reason', async () => {
    for (const [reason, code] of [['no-model', 503], ['timeout', 504], ['upstream', 502]] as const) {
      grade.out = { ok: false, reason, error: 'e' };
      const r = await post('/api/learning/grade', alice.cookie, body).expect(code);
      expect(r.body.reason).toBe(reason);
    }
  });
});

describe('学习者模型与误区', () => {
  it('★ 只看得到自己的误区；解决别人的 404', async () => {
    const id = recordMisconception(alice.id, { termId: null, topic: '主题', note: '甲的误区' });
    const a = await request(app).get('/api/learning/model').set('Origin', origin).set('Cookie', alice.cookie).expect(200);
    expect(a.body.misconceptions.map((m: { note: string }) => m.note)).toEqual(['甲的误区']);
    expect(a.body).toHaveProperty('calibration', null);
    expect(a.body.ability).toMatchObject({ n: 0, level: null });
    expect(a.body).toHaveProperty('fsrs', null);
    const b = await request(app).get('/api/learning/model').set('Origin', origin).set('Cookie', bob.cookie).expect(200);
    expect(b.body.misconceptions).toEqual([]);
    await post(`/api/learning/misconceptions/${id}/resolve`, bob.cookie).expect(404);
    await post(`/api/learning/misconceptions/${id}/resolve`, alice.cookie).expect(200);
  });
});

describe('GET /api/learning/terms/:id/relations', () => {
  it('没有关系 ⇒ 空列表（形状稳定）', async () => {
    const r = await request(app).get('/api/learning/terms/nope/relations').set('Origin', origin).set('Cookie', alice.cookie).expect(200);
    expect(r.body).toEqual({ items: [] });
  });
});
