/**
 * routes/ember — 「余烬笺 · 意外发现」端到端：A 写笺 → B 的大陆上出现 A 的火 → B 收入卡册 / 致谢 → A 看到被谢次数。
 * ★ 同时锁住三条边界：只能给自己的词条写笺；自己的笺不会出现在自己的大陆上；收下时不覆盖读者已有的同名词条。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-ember-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
async function signUp(email: string): Promise<string> {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return `${AUTH_COOKIE_NAME}=${token}`;
}
const get = (url: string, c: string) => request(app).get(url).set('Origin', origin).set('Cookie', c);
const post = (url: string, c: string, body: unknown = {}) => request(app).post(url).set('Origin', origin).set('Cookie', c).send(body as object);

const A = await signUp('ember-a@example.com');
const B = await signUp('ember-b@example.com');

afterAll(() => closeDb());

describe('余烬笺', () => {
  it('写笺只认自己的词条，正文太短会被拒', async () => {
    const tb = await post('/api/terms', B, { term: 'B 的词', definition: 'B 的释义', domain: '物理' });
    expect((await post('/api/ember', A, { termId: tb.body.id, body: '我想偷偷替 B 写一张笺' })).status).toBe(404);
    const ta = await post('/api/terms', A, { term: '费曼学习法', definition: '用教别人的方式检验理解', domain: '学习方法' });
    expect((await post('/api/ember', A, { termId: ta.body.id, body: '太短' })).status).toBe(400);
  });

  it('A 写笺 → 只出现在 B 的大陆上；B 收入卡册、致谢一次；A 能看到被谢次数', async () => {
    const ta = await post('/api/terms', A, { term: '机会成本', definition: '为此放弃的下一个最好选择', domain: '经济学' });
    const w = await post('/api/ember', A, { termId: ta.body.id, body: '今晚刷题不打游戏，那局排位就是我的机会成本。', sign: '北坡的石头' });
    expect(w.status).toBe(201);
    expect(w.body.note.sign).toBe('北坡的石头');

    expect((await get('/api/ember/spot', A)).body.spot).toBeNull(); // 自己的火不烧在自己的大陆上

    const spot = (await get('/api/ember/spot', B)).body.spot;
    expect(spot).not.toBeNull();
    expect(spot.note.sign).toBe('北坡的石头');
    expect(Number.isInteger(spot.row) && Number.isInteger(spot.col)).toBe(true);

    const keep = await post(`/api/ember/${spot.note.id}/keep`, B);
    expect(keep.status).toBe(200);
    const bTerms = (await get('/api/terms', B)).body;
    const list = Array.isArray(bTerms) ? bTerms : bTerms.items ?? bTerms.terms ?? [];
    expect(JSON.stringify(list)).toContain(spot.note.term);

    const t1 = await post(`/api/ember/${spot.note.id}/thank`, B);
    const t2 = await post(`/api/ember/${spot.note.id}/thank`, B);
    expect(t1.body.thanks).toBe(t2.body.thanks); // 每人只算一次
    const mine = (await get('/api/ember/mine', A)).body.notes as Array<{ id: string; thanks: number }>;
    expect(mine.find((n) => n.id === spot.note.id)?.thanks).toBeGreaterThanOrEqual(1);
  });

  it('收下时不覆盖读者已有的同名词条释义', async () => {
    const ta = await post('/api/terms', A, { term: '递归', definition: 'A 的释义', domain: '计算机' });
    const w = await post('/api/ember', A, { termId: ta.body.id, body: '每次把问题变小一点，并且知道什么时候停。' });
    await post('/api/terms', B, { term: '递归', definition: 'B 自己写的释义', domain: '计算机' });
    const k = await post(`/api/ember/${w.body.note.id}/keep`, B);
    expect(k.body.already).toBe(true);
    const bTerms = JSON.stringify((await get('/api/terms', B)).body);
    expect(bTerms).toContain('B 自己写的释义');
  });
});
