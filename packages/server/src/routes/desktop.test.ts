import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-desktop-'));
process.env.SB_DESKTOP = '1'; process.env.SB_HOST = '127.0.0.1';
const generation = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../learning/campfire-opener.js', () => ({ generateCampfireOpener: async (_owner: unknown, _exclude: unknown, _signal: unknown, material: string) => {
  generation.calls.push(material); return { ok: false, status: 503, error: '测试未配置模型' };
} }));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { browserStore } = await import('../desktop/browser-store.js');
const { collectContextSegments } = await import('../chat/context-segments.js');
const request = (await import('supertest')).default;
const origin = 'http://localhost:5173'; const extension = 'chrome-extension://' + 'a'.repeat(32);
let sid = '';
beforeEach(() => {
  process.env.SB_DESKTOP = '1'; process.env.SB_HOST = '127.0.0.1'; generation.calls = []; browserStore.clear(null);
  sid = crypto.randomUUID(); getDb().prepare('INSERT INTO sessions (id) VALUES (?)').run(sid);
});
afterAll(() => { closeDb(); delete process.env.SB_DESKTOP; delete process.env.SB_HOST; });
const page = { url: 'https://example.org/article', title: '网页测试', text: '海马体帮助形成新的陈述性记忆。', selection: '海马体', viewport: '', epoch: 'article-111', seq: 1 };
async function pair() {
  const code = await request(app).post('/api/desktop/browser/pair-code').set('Origin', origin).send({ sessionId: sid }).expect(200);
  const paired = await request(app).post('/api/desktop/bridge/pair').set('Origin', extension).send({ code: code.body.code }).expect(200);
  return paired.body.token as string;
}
it('hosted deployments and DNS-rebound hostnames cannot enable the local bridge', async () => {
  delete process.env.SB_DESKTOP;
  await request(app).get('/api/desktop/study').expect(404);
  await request(app).post('/api/desktop/bridge/pair').send({ code: '1234567890' }).expect(404);
  process.env.SB_DESKTOP = '1';
  await request(app).get('/api/desktop/browser').set('Host', 'attacker.example:18794').expect(404);
  process.env.SB_HOST = '0.0.0.0'; await request(app).get('/api/desktop/study').expect(404);
});
it('management keeps normal CSRF checks; extension capabilities cannot call settings', async () => {
  await request(app).post('/api/desktop/study').send({ enabled: true, intervalMinutes: 3, scope: 'learning' }).expect(403);
  await request(app).post('/api/desktop/study').set('Origin', extension).send({ enabled: true, intervalMinutes: 3, scope: 'learning' }).expect(403);
  await request(app).post('/api/desktop/bridge/pair').set('Origin', 'https://evil.example').send({ code: '1234567890' }).expect(403);
  const preflight = await request(app).options('/api/desktop/bridge/page').set('Origin', extension).expect(204);
  expect(preflight.headers['access-control-allow-origin']).toBe(extension);
});
it('requires an existing conversation and a one-use code plus a scoped token', async () => {
  await request(app).post('/api/desktop/browser/pair-code').set('Origin', origin).send({ sessionId: 'missing' }).expect(404);
  await request(app).post('/api/desktop/bridge/page').set('Origin', extension).send(page).expect(401);
  const token = await pair();
  await request(app).post('/api/desktop/bridge/page').set('Authorization', `Bearer ${token}`).send(page).expect(200);
  const state = await request(app).get('/api/desktop/browser').expect(200);
  expect(state.body.page.connected).toBe(true); expect(state.body.page).not.toHaveProperty('text');
  const segments = collectContextSegments({ history: [], sessionId: sid, text: '海马体的作用是什么？' });
  expect(segments.segments.some(s => s.kind === 'doc' && s.content.includes('陈述性记忆'))).toBe(true);
  expect(getDb().prepare('SELECT doc_text FROM sessions WHERE id = ?').get(sid)).toEqual({ doc_text: null });
});
it('stopping from the local reader revokes the extension and clears the RAG immediately', async () => {
  const token = await pair();
  await request(app).post('/api/desktop/bridge/page').set('Authorization', `Bearer ${token}`).send(page).expect(200);
  await request(app).delete('/api/desktop/browser').set('Origin', origin).expect(200);
  expect(browserStore.block(null, sid, '海马体')).toBe('');
  await request(app).post('/api/desktop/bridge/page').set('Authorization', `Bearer ${token}`).send({ ...page, seq: 2 }).expect(401);
});
it('a deleted bound conversation rejects further extension updates', async () => {
  const token = await pair(); getDb().prepare('UPDATE sessions SET deleted_at = ? WHERE id = ?').run(Date.now(), sid);
  await request(app).post('/api/desktop/bridge/page').set('Authorization', `Bearer ${token}`).send(page).expect(404);
});
it('persists opt-in interval settings and supplies fresh webpage material to timed questions', async () => {
  const token = await pair();
  await request(app).post('/api/desktop/bridge/page').set('Authorization', `Bearer ${token}`).send(page).expect(200);
  await request(app).post('/api/desktop/study').set('Origin', origin).send({ enabled: true, intervalMinutes: 3, scope: 'browser' }).expect(200);
  await request(app).post('/api/desktop/study/tick').set('Origin', origin).send({ eligible: true }).expect(200);
  expect(generation.calls.at(-1)).toContain('陈述性记忆');
  expect(JSON.parse((getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get('desktop.study') as { value: string }).value).intervalMinutes).toBe(3);
  await request(app).post('/api/desktop/study').set('Origin', origin).send({ enabled: false, intervalMinutes: 3, scope: 'browser' }).expect(200);
  await request(app).post('/api/desktop/study').set('Origin', origin).send({ enabled: true, intervalMinutes: 0, scope: 'browser' }).expect(400);
});
