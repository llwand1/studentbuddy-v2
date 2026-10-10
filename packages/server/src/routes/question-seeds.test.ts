import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';
process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-seed-api-'));
process.env.SB_REQUIRE_AUTH = '1';
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');
const { resetAgentRateLimits } = await import('./agent-terms.js');
const request = (await import('supertest')).default;
const a = await createUser('seed-a@example.com', 'good-password-1', 'A');
const b = await createUser('seed-b@example.com', 'good-password-1', 'B');
const origin = 'http://localhost:5173', base = '/api/open/v1/question-seeds';
const cookie = (id: string) => `${AUTH_COOKIE_NAME}=${createSession(id).token}`;
const seed = () => ({ externalId: 'rag-1', topic: 'RAG', tags: ['RAG'], objective: '资料增强回答', facts: ['检索获取资料'], rubric: ['检索', '生成'], variations: ['改变信息缺口'], types: ['single'], validUntil: new Date(Date.now() + 86400000).toISOString() });
const key = async (owner = a.id, questionSeeds = true) => (await request(app).post('/api/settings/agent-keys').set('Origin', origin).set('Cookie', cookie(owner)).send({ name: 'seed-agent', questionSeeds })).body as { token: string; key: { id: string; permissions: string[] } };
const send = (token: string, body: object) => request(app).post(base + '/import').set('Authorization', 'Bearer ' + token).send(body);
const read = (token: string, query = '') => request(app).get(base + query).set('Authorization', 'Bearer ' + token);
beforeEach(() => { resetAgentRateLimits(); getDb().prepare('DELETE FROM agent_term_key').run(); getDb().prepare('DELETE FROM app_settings').run(); });
afterAll(closeDb);
describe('出题预产物真实 HTTP', () => {
  it('旧词条 key 不扩权，cookie 也不能替代 Bearer；显式授权后才可导入', async () => {
    const old = await key(a.id, false), fresh = await key();
    expect((await send(old.token, { batchId: 'b', seeds: [seed()] })).status).toBe(403);
    expect((await request(app).post(base + '/import').set('Cookie', cookie(a.id)).send({ batchId: 'b', seeds: [seed()] })).status).toBe(401);
    expect((await send(fresh.token, { batchId: 'b', seeds: [seed()] })).status).toBe(200);
    expect(fresh.key.permissions).toContain('question-seeds:write');
    const ctx = await request(app).get('/api/open/v1/context').set('Authorization', 'Bearer ' + fresh.token);
    expect(ctx.body.exam.signature).toBe('all'); expect(ctx.body.permissions).toContain('question-seeds:read');
  });
  it('整批先校验，坏第二条零写入，不接收成品题', async () => {
    const k = await key();
    const r = await send(k.token, { batchId: 'b', seeds: [seed(), { ...seed(), externalId: 'bad', answer: [0] }] });
    expect(r.status).toBe(400); expect(r.body.index).toBe(1); expect((await read(k.token)).body.total).toBe(0);
  });
  it('回放、批次冲突和 externalId 冲突精确；冲突批次回滚前一条', async () => {
    const k = await key(), data = { batchId: 'b', seeds: [seed()] };
    expect((await send(k.token, data)).body.added).toBe(1);
    expect((await send(k.token, data)).body.replayed).toBe(true);
    expect((await send(k.token, { ...data, seeds: [{ ...data.seeds[0], facts: ['不同内容'] }] })).status).toBe(409);
    expect((await send(k.token, { batchId: 'c', seeds: [{ ...data.seeds[0], externalId: 'new' }, { ...data.seeds[0], facts: ['冲突'] }] })).status).toBe(409);
    expect((await read(k.token)).body.total).toBe(1);
    expect((await send(k.token, { ...data, batchId: 'd' })).body).toMatchObject({ added: 0, skipped: 1 });
  });
  it('已过期旧批次仍可幂等回放，重新导入过期新条目被拒', async () => {
    const k = await key(), data = { batchId: 'b', seeds: [seed()] };
    await send(k.token, data);
    const future = Date.now() + 2 * 86400000; vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      const replay = await send(k.token, data); expect(replay.status).toBe(200); expect(replay.body.results[0]).toMatchObject({ eligible: false, reason: '已过有效期' });
      expect((await send(k.token, { ...data, batchId: 'new' })).status).toBe(400);
    } finally { vi.restoreAllMocks(); }
  });
  it('账号隔离与撤下不会动聊天/词条；旧回执标记 withdrawn', async () => {
    const ka = await key(), kb = await key(b.id), data = { batchId: 'b', seeds: [seed()] };
    const r = await send(ka.token, data), id = r.body.results[0].id;
    expect((await read(kb.token)).body.total).toBe(0);
    expect((await request(app).delete(base + '/' + id).set('Authorization', 'Bearer ' + kb.token)).status).toBe(404);
    const before = getDb().prepare('SELECT COUNT(*) n FROM messages').get();
    await request(app).delete(base + '/' + id).set('Authorization', 'Bearer ' + ka.token).expect(200);
    expect((await send(ka.token, data)).body.results[0]).toMatchObject({ withdrawn: true, eligible: false });
    expect(getDb().prepare('SELECT COUNT(*) n FROM messages').get()).toEqual(before);
  });
  it('撤销与过期拒绝全部预产物操作，不能用 key 读取普通聊天', async () => {
    const k = await key();
    expect((await request(app).get('/api/chat/sessions').set('Authorization', 'Bearer ' + k.token)).status).toBe(401);
    getDb().prepare('UPDATE agent_term_key SET revoked_at=? WHERE id=?').run(Date.now(), k.key.id);
    expect((await read(k.token)).status).toBe(401);
    const next = await key(); getDb().prepare('UPDATE agent_term_key SET expires_at=1 WHERE id=?').run(next.key.id);
    expect((await send(next.token, { batchId: 'b', seeds: [seed()] })).status).toBe(401);
  });
  it('分页、集合与请求体边界，公开规范可供 agent 自助接入', async () => {
    const k = await key();
    expect((await read(k.token, '?limit=201')).status).toBe(400);
    expect((await send(k.token, { batchId: 'b', seeds: Array(51).fill(seed()) })).status).toBe(400);
    expect((await send(k.token, { batchId: 'b', seeds: [{ ...seed(), facts: ['x'.repeat(600000)] }] })).status).toBe(413);
    const spec = await request(app).get('/api/open/v1/openapi.json');
    expect(spec.body.paths['/question-seeds/import'].post.requestBody.content['application/json'].schema.required).toContain('seeds');
  });
  it('预产物与词条接口共用每账号限流', async () => {
    const k = await key(); for (let n = 0; n < 60; n++) await read(k.token);
    const r = await request(app).get('/api/open/v1/context').set('Authorization', 'Bearer ' + k.token);
    expect(r.status).toBe(429); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });
});
