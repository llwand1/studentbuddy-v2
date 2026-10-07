import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';
process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agent-terms-'));
process.env.SB_REQUIRE_AUTH = '1';
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');
const { resetAgentRateLimits } = await import('./agent-terms.js');
const request = (await import('supertest')).default;
const userA = await createUser('agent-a@example.com', 'good-password-1', '甲');
const userB = await createUser('agent-b@example.com', 'good-password-1', '乙');
const cookieA = `${AUTH_COOKIE_NAME}=${createSession(userA.id).token}`;
const cookieB = `${AUTH_COOKIE_NAME}=${createSession(userB.id).token}`;
const origin = 'http://localhost:5173';
const base = '/api/open/v1';
const item = { term: 'RAG', definition: '检索外部知识辅助生成回答', domain: 'LLM', aliases: ['检索增强生成'] };
const post = (cookie: string, url: string, body: object) => request(app).post(url).set('Origin', origin).set('Cookie', cookie).send(body);
async function key(cookie = cookieA) {
  const r = await post(cookie, '/api/settings/agent-keys', { name: '测试 agent', days: 30 });
  expect(r.status).toBe(201); return r.body as { token: string; key: { id: string } };
}
const send = (token: string, body: object) => request(app).post(base + '/terms/import').set('Authorization', 'Bearer ' + token).send(body);
beforeEach(() => {
  resetAgentRateLimits();
  for (const table of ['agent_term_key', 'agent_term_receipt', 'term_library', 'term_domain', 'term_source', 'search_index', 'app_settings']) getDb().prepare(`DELETE FROM ${table}`).run();
});
afterAll(() => closeDb());
describe('外部 agent 的实际 HTTP 导入链路', () => {
  it('规范公开，其余必须专用 key；cookie 和登录会话 token 都不能写入', async () => {
    expect((await request(app).get(base + '/openapi.json')).status).toBe(200);
    expect((await request(app).get(base + '/context')).status).toBe(401);
    expect((await request(app).post(base + '/terms/import').set('Cookie', cookieA).send({ batchId: 'a', terms: [item] })).status).toBe(401);
    expect((await send(cookieA.split('=')[1]!, { batchId: 'a', terms: [item] })).status).toBe(401);
  });
  it('无 Origin 的 CLI 成功追加，索引和复习范围同步，密钥列表不返回明文或哈希', async () => {
    const { token } = await key();
    const r = await send(token, { batchId: 'desktop-a', terms: [item] });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ added: 1, skipped: 0, replayed: false });
    const row = getDb().prepare('SELECT * FROM term_library WHERE id = ?').get(r.body.results[0].id) as { owner_id: string; domain: string; review_enabled: number };
    expect(row).toMatchObject({ owner_id: userA.id, domain: 'llm', review_enabled: 1 });
    expect(getDb().prepare('SELECT ref_id FROM search_index WHERE ref_id = ?').get(r.body.results[0].id)).toBeTruthy();
    const list = await request(app).get('/api/settings/agent-keys').set('Cookie', cookieA);
    expect(JSON.stringify(list.body)).not.toContain(token); expect(JSON.stringify(list.body)).not.toContain('token_hash');
    expect((getDb().prepare('SELECT token_hash FROM agent_term_key').get() as { token_hash: string }).token_hash).not.toBe(token);
  });
  it('批次重试回放，同 ID 不同内容拒绝，别名和大小写重复不覆盖复习进度', async () => {
    const { token } = await key();
    const body = { batchId: 'same', terms: [item] };
    const first = await send(token, body);
    const id = first.body.results[0].id as string;
    getDb().prepare('UPDATE term_library SET review_stage = 3, usage_count = 7 WHERE id = ?').run(id);
    expect((await send(token, body)).body).toMatchObject({ added: 1, replayed: true });
    expect((await send(token, { ...body, terms: [{ ...item, definition: '不同释义' }] })).status).toBe(409);
    const duplicate = await send(token, { batchId: 'second', terms: [{ ...item, term: 'rag', definition: '不能覆盖' }, { ...item, term: '检索增强生成', domain: '其他领域' }] });
    expect(duplicate.body).toMatchObject({ added: 0, skipped: 2 });
    expect(getDb().prepare('SELECT definition,review_stage,usage_count FROM term_library WHERE id = ?').get(id)).toEqual({ definition: item.definition, review_stage: 3, usage_count: 7 });
    expect((getDb().prepare('SELECT COUNT(*) n FROM term_library').get() as { n: number }).n).toBe(1);
  });
  it('坏条目让整批零写入，body 不能伪造归属或复习进度', async () => {
    const { token } = await key();
    const r = await send(token, { batchId: 'bad', terms: [item, { ...item, term: '空释义', definition: '' }] });
    expect(r.status).toBe(400); expect(r.body.index).toBe(1);
    expect((await send(token, { batchId: 'owner', owner_id: userB.id, terms: [item] })).status).toBe(400);
    expect((getDb().prepare('SELECT COUNT(*) n FROM term_library').get() as { n: number }).n).toBe(0);
    expect((getDb().prepare('SELECT COUNT(*) n FROM agent_term_receipt').get() as { n: number }).n).toBe(0);
  });
  it('不同账号同批 ID 和同名词隔离，cookie 不改变专用 key 的归属', async () => {
    const a = await key(), b = await key(cookieB);
    const body = { batchId: 'both', terms: [item] };
    expect((await send(a.token, body)).body.added).toBe(1);
    expect((await send(b.token, body)).body.added).toBe(1);
    const readA = await request(app).get(base + '/terms').set('Authorization', 'Bearer ' + a.token).set('Cookie', cookieB);
    expect(readA.body.terms).toHaveLength(1);
    const id = readA.body.terms[0].id as string;
    expect((getDb().prepare('SELECT owner_id FROM term_library WHERE id = ?').get(id) as { owner_id: string }).owner_id).toBe(userA.id);
    expect((await request(app).delete('/api/settings/agent-keys/' + a.key.id).set('Cookie', cookieB).set('Origin', origin)).status).toBe(404);
  });
  it('key 不授权普通接口或密钥管理；撤销、过期后立即拒绝重试', async () => {
    const a = await key();
    expect((await request(app).get('/api/terms').set('Authorization', 'Bearer ' + a.token)).status).toBe(401);
    expect((await request(app).post('/api/settings/agent-keys').set('Origin', origin).set('Authorization', 'Bearer ' + a.token).send({ name: '越权' })).status).toBe(401);
    expect((await request(app).delete('/api/settings/agent-keys/' + a.key.id).set('Cookie', cookieA).set('Origin', origin)).status).toBe(200);
    expect((await send(a.token, { batchId: 'a', terms: [item] })).status).toBe(401);
    const b = await key(); getDb().prepare('UPDATE agent_term_key SET expires_at = 0 WHERE id = ?').run(b.key.id);
    expect((await request(app).get(base + '/terms').set('Authorization', 'Bearer ' + b.token)).status).toBe(401);
  });
  it('新词才加入复习，批内重复也跳过，review=false 继承领域', async () => {
    const { token } = await key();
    const r = await send(token, { batchId: 'no-review', review: false, terms: [item, { ...item, term: 'rag' }] });
    expect(r.body).toMatchObject({ added: 1, skipped: 1 });
    expect((getDb().prepare('SELECT review_enabled FROM term_library').get() as { review_enabled: null }).review_enabled).toBe(null);
  });
  it('外部来源标记 agent；白名单内外/无来源回执与现有词条视图一致', async () => {
    const { token } = await key();
    await request(app).put('/api/settings/exam-mode').set('Cookie', cookieA).set('Origin', origin).send({ on: true });
    await request(app).put('/api/settings/exam-scope').set('Cookie', cookieA).set('Origin', origin).send({ packs: [], custom: ['example.com'] });
    const r = await send(token, { batchId: 'sources', terms: [
      { ...item, sourceUrls: ['https://example.com/rag'] },
      { ...item, term: '无出处', aliases: [], source_host: '学习者自选' },
      { ...item, term: '范围外', aliases: [], sourceUrls: ['https://other.example/rag'] },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.results.map((v: { visibleInCurrentScope: boolean }) => v.visibleInCurrentScope)).toEqual([true, false, false]);
    expect(getDb().prepare('SELECT origin FROM term_source WHERE term_id = ?').get(r.body.results[0].id)).toEqual({ origin: 'agent' });
    const visible = await request(app).get('/api/terms').set('Cookie', cookieA);
    expect(visible.body).toHaveLength(1);
    const all = await request(app).get(base + '/terms?limit=2').set('Authorization', 'Bearer ' + token);
    expect(all.body).toMatchObject({ total: 3, nextOffset: 2 });
    expect((await request(app).get(base + '/context').set('Authorization', 'Bearer ' + token)).body.exam.allowedHosts).toContain('example.com');
  });
  it('管理仍要求 Origin；有效密钥数、集合、payload 与分页都有上限', async () => {
    expect((await request(app).post('/api/settings/agent-keys').set('Cookie', cookieA).send({ name: '无 Origin' })).status).toBe(403);
    const a = await key(); for (let n = 0; n < 4; n++) await key();
    expect((await post(cookieA, '/api/settings/agent-keys', { name: '第六个' })).status).toBe(429);
    expect((await send(a.token, { batchId: 'huge', terms: Array(101).fill(item) })).status).toBe(400);
    expect((await request(app).get(base + '/terms?limit=201').set('Authorization', 'Bearer ' + a.token)).status).toBe(400);
    expect((await send(a.token, { batchId: 'oversize', terms: [{ ...item, definition: 'x'.repeat(600000) }] })).status).toBe(413);
  });
  it('同 owner 多密钥共享限流，429 有可执行的重试时间', async () => {
    const a = await key(), b = await key();
    for (let n = 0; n < 60; n++) expect((await request(app).get(base + '/context').set('Authorization', 'Bearer ' + a.token)).status).toBe(200);
    const r = await request(app).get(base + '/context').set('Authorization', 'Bearer ' + b.token);
    expect(r.status).toBe(429); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });
});
