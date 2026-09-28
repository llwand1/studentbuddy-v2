/**
 * routes/continent-world.test — 开拓制大陆的写口契约：GET 世界 / POST 开拓 / POST 打怪。
 * 锁：从零开始、只能开紧挨着的迷雾、开拓令会用完、打怪一次开一片并记图鉴、账户隔离。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, frontierCells, wildMonsters, type WorldSave } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-world-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches, createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
async function signUp(email: string): Promise<string> {
  const user = await createUser(email, 'good-password-1', undefined);
  return `${AUTH_COOKIE_NAME}=${issueSession(user.id).token}`;
}
const get = (url: string, c: string) => request(app).get(url).set('Origin', origin).set('Cookie', c);
const post = (url: string, c: string, body: object) => request(app).post(url).set('Origin', origin).set('Cookie', c).send(body);

const A = await signUp('cw-a@example.com');
const B = await signUp('cw-b@example.com');

interface Payload { world: WorldSave; termCount: number; day: number }

beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
  const db = getDb();
  db.prepare('DELETE FROM term_library').run();
  db.prepare(`DELETE FROM app_settings WHERE key = 'continent_world'`).run();
});
afterAll(() => closeDb());

async function addTerms(n: number, c = A): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await post('/api/terms', c, { term: `词${i}`, definition: `词${i} 的释义`, domain: '域' });
    expect(r.status).toBe(201);
    ids.push((r.body as { id: string }).id);
  }
  return ids;
}

describe('/api/continent/world', () => {
  it('新账户从零开始：只有出生点一格', async () => {
    const r = await get('/api/continent/world', A).expect(200);
    expect(Object.keys((r.body as Payload).world.cells)).toEqual(['0,0']);
  });

  it('开拓：紧挨着 ⇒ 200 + 新格；远处 ⇒ 409；开拓令用完 ⇒ 409', async () => {
    await addTerms(1); // 开拓令 = 2 + 1
    const w0 = (await get('/api/continent/world', A)).body as Payload;
    await post('/api/continent/explore', A, { row: 5, col: 5 }).expect(409);
    const ids = ['x'];
    let ok = 0;
    let last = 200;
    let w = w0.world;
    for (let i = 0; i < 6 && last === 200; i++) {
      const cand = frontierCells(w).find((c) => !wildMonsters(w, ids, w0.day).some((m) => m.row === c.row && m.col === c.col))!;
      const r = await post('/api/continent/explore', A, cand);
      last = r.status;
      if (r.status === 200) { ok++; w = (r.body as Payload).world; }
    }
    expect(ok).toBe(3);
    expect(last).toBe(409);
  });

  it('★ 打怪：一次开多格、记图鉴；同一只打第二次 ⇒ 409', async () => {
    await addTerms(4);
    let p = (await get('/api/continent/world', A)).body as Payload;
    for (let i = 0; i < 4; i++) {
      await post('/api/continent/explore', A, frontierCells(p.world)[i % 4]!);
      p = (await get('/api/continent/world', A)).body as Payload;
    }
    const ids = Object.values(p.world.cells).map((c) => c.t).filter((t): t is string => !!t);
    const mon = wildMonsters(p.world, ids, p.day)[0];
    expect(mon).toBeTruthy();
    const r = await post('/api/continent/slay', A, { row: mon!.row, col: mon!.col, day: p.day }).expect(200);
    expect((r.body as { fresh: unknown[] }).fresh.length).toBeGreaterThanOrEqual(3);
    expect((r.body as Payload).world.codex.length).toBe(1);
    await post('/api/continent/slay', A, { row: mon!.row, col: mon!.col, day: p.day }).expect(409);
  });

  it('坐标不对 ⇒ 400；账户隔离：A 的开拓不影响 B', async () => {
    await post('/api/continent/explore', A, { row: 'x' }).expect(400);
    await addTerms(1);
    const a = (await get('/api/continent/world', A)).body as Payload;
    const c = frontierCells(a.world)[0]!;
    await post('/api/continent/explore', A, c);
    const b = (await get('/api/continent/world', B)).body as Payload;
    expect(Object.keys(b.world.cells)).toEqual(['0,0']);
  });
});
