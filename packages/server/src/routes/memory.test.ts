/**
 * routes/memory 端到端（supertest，同 notes.test.ts 手法）。
 * 钉三件事：画像列表可读；单条删的 **404 语义**（前端要能区分「删错了」）；
 * 会话摘要的查询与清空逃生口（ADR-5 不静默——自动写入的东西必须看得见、改得掉）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-memory-route-test-'));
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { loadMemoryItems, upsertMemoryItems } = await import('../chat/memory.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

afterAll(() => closeDb());

const list = () => request(app).get('/api/memory').set('Origin', origin);
const remove = (id: string) => request(app).delete(`/api/memory/${id}`).set('Origin', origin);
const clearAll = () => request(app).delete('/api/memory').set('Origin', origin);
const getSummary = (sid: string) => request(app).get(`/api/memory/summary/${sid}`).set('Origin', origin);
const clearSummary = (sid: string) => request(app).delete(`/api/memory/summary/${sid}`).set('Origin', origin);

describe('GET /api/memory（列表）', () => {
  it('返画像数组，字段齐备（记忆页要能按 kind 分组渲染）', async () => {
    upsertMemoryItems([{ kind: 'weakness', content: '路由测试-薄弱点', importance: 0.9 }]);
    const res = await list();
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ kind: string; content: string; importance: number }>;
    const hit = rows.find((r) => r.content === '路由测试-薄弱点');
    expect(hit?.kind).toBe('weakness');
    expect(hit?.importance).toBe(0.9);
  });

  it('空库返空数组而不是 404（开箱路径）', async () => {
    await clearAll();
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('DELETE /api/memory/:id', () => {
  it('未知 id 回 404（与 terms 的恒 200 不同：这里前端要能区分删错了）', async () => {
    const res = await remove('not-exist-id');
    expect(res.status).toBe(404);
  });

  it('已知 id 删除成功，列表随即少一条', async () => {
    upsertMemoryItems([{ kind: 'goal', content: '路由测试-待删', importance: 0.6 }]);
    const id = loadMemoryItems().find((m) => m.content === '路由测试-待删')?.id ?? '';
    const res = await remove(id);
    expect(res.status).toBe(200);
    expect(loadMemoryItems().some((m) => m.content === '路由测试-待删')).toBe(false);
  });
});

describe('DELETE /api/memory（全部清空）', () => {
  it('清空并如实回条数', async () => {
    upsertMemoryItems([
      { kind: 'profile', content: '路由测试-A', importance: 0.5 },
      { kind: 'preference', content: '路由测试-B', importance: 0.5 },
    ]);
    const res = await clearAll();
    expect(res.status).toBe(200);
    expect((res.body as { removed: number }).removed).toBeGreaterThanOrEqual(2);
    expect(loadMemoryItems()).toHaveLength(0);
  });
});

describe('会话摘要（查询 + 清空逃生口）', () => {
  it('未压缩过的会话：hasSummary=false', async () => {
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES ('route-s1', '测试')`).run();
    const res = await getSummary('route-s1');
    expect(res.status).toBe(200);
    expect((res.body as { hasSummary: boolean }).hasSummary).toBe(false);
  });

  it('有摘要时 hasSummary=true 并带锚点', async () => {
    getDb()
      .prepare(`UPDATE sessions SET summary = '早前聊了导数', summary_upto_rowid = 12 WHERE id = 'route-s1'`)
      .run();
    const res = await getSummary('route-s1');
    const body = res.body as { hasSummary: boolean; summary: string; uptoRowid: number };
    expect(body.hasSummary).toBe(true);
    expect(body.summary).toBe('早前聊了导数');
    expect(body.uptoRowid).toBe(12);
  });

  it('清空后回到未压缩态（下一轮从零重算）', async () => {
    await clearSummary('route-s1');
    const res = await getSummary('route-s1');
    const body = res.body as { hasSummary: boolean; uptoRowid: number };
    expect(body.hasSummary).toBe(false);
    expect(body.uptoRowid).toBe(0);
  });

  it('未知会话清空也回 200（幂等，不因会话不存在而报错）', async () => {
    const res = await clearSummary('no-such-session');
    expect(res.status).toBe(200);
  });
});
