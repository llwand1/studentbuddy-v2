/**
 * routes/pk 登录端到端（supertest，同 document.test.ts 手法）。
 * 钉四件事：登录建号；携带 userId 找回原账号（可改名）；nickname 校验；
 * /auth/me 本地登录态校验（未知账号 404）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pk-auth-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

// 写操作过跨源闸门（originCheck）：与 document.test.ts 同款，模拟合法前端源
const origin = 'http://localhost:5173';
const post = (url: string) => request(app).post(url).set('Origin', origin);
const get = (url: string) => request(app).get(url).set('Origin', origin);

describe('POST /api/pk/auth/login（P0 模拟登录，契约 docs/PK-SPEC.md §2.1）', () => {
  it('首登建号：返回 userId/openid=mock_<userId>/nickname，且账号真的落了库', async () => {
    const res = await post('/api/pk/auth/login').send({ nickname: '  团子  ' });
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe('团子'); // trim，不保留原样
    expect(res.body.openid).toBe(`mock_${res.body.userId}`);
    const { getDb } = await import('../storage/db.js');
    const row = getDb().prepare(`SELECT id, openid, nickname FROM pk_users WHERE id = ?`).get(res.body.userId) as {
      openid: string;
      nickname: string;
    };
    expect(row).toBeTruthy();
    expect(row.openid).toBe(`mock_${res.body.userId}`);
  });

  it('携带 userId 再登 = 找回原账号，可顺带改名，openid 不变', async () => {
    const first = await post('/api/pk/auth/login').send({ nickname: '阿團' });
    const again = await post('/api/pk/auth/login')
      .send({ nickname: '改名后的团子', userId: first.body.userId });
    expect(again.status).toBe(200);
    expect(again.body.userId).toBe(first.body.userId);
    expect(again.body.openid).toBe(first.body.openid);
    expect(again.body.nickname).toBe('改名后的团子');
  });

  it('携带不存在的 userId = 不复活幽灵账号，走新建', async () => {
    const res = await post('/api/pk/auth/login')
      .send({ nickname: '新人', userId: 'u-not-exist' });
    expect(res.status).toBe(200);
    expect(res.body.userId).not.toBe('u-not-exist');
  });

  it.each([
    ['缺 nickname', {}],
    ['纯空白', { nickname: '   ' }],
    ['超 20 字', { nickname: '一'.repeat(21) }],
    ['非字符串', { nickname: 42 }],
  ])('非法昵称（%s）→ 400 且不落库', async (_label, body) => {
    const { getDb } = await import('../storage/db.js');
    const before = (getDb().prepare(`SELECT COUNT(*) AS c FROM pk_users`).get() as { c: number }).c;
    const res = await post('/api/pk/auth/login').send(body);
    expect(res.status).toBe(400);
    const after = (getDb().prepare(`SELECT COUNT(*) AS c FROM pk_users`).get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('20 字昵称恰好通过（边界不误伤）', async () => {
    const res = await post('/api/pk/auth/login').send({ nickname: '学'.repeat(20) });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/pk/auth/me（本地登录态校验）', () => {
  it('存在的 userId → 返回身份', async () => {
    const login = await post('/api/pk/auth/login').send({ nickname: '查我' });
    const res = await get(`/api/pk/auth/me?userId=${login.body.userId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(login.body);
  });

  it.each([
    ['未知账号', 'u-ghost'],
    ['缺参', ''],
  ])('%s → 404（前端据此清本地登录态）', async (_label, userId) => {
    const res = await get(`/api/pk/auth/me?userId=${userId}`);
    expect(res.status).toBe(404);
  });
});

afterAll(() => {
  closeDb();
});
