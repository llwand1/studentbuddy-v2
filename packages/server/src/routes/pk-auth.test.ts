/**
 * routes/pk 身份端到端（supertest，同 document.test.ts 手法）。
 *
 * ★ B1（§14.1，2026-09-20）整文件改写。改造前这里钉的是 PK 自建账号
 *   （POST /auth/login + `openid=mock_<id>` + localStorage）——那套已整体废弃，
 *   身份并入统一账号（AUTH-SPEC）：「我是谁」由 httpOnly cookie 会话说了算。
 *   本文件跑 **cloud 形态**（SB_REQUIRE_AUTH=1），钉四件事：
 *     ① 旧登录端点已删除（404，不是静默降级）；
 *     ② 未登录 → 401 UNAUTHENTICATED（/auth/me 从 404 改 401）；
 *     ③ 登录后 /auth/me 返回的 PkIdentity 就是统一账号本身；
 *     ④ 会话身份能直接建房（身份链路端到端打穿）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pk-auth-test-'));
process.env.SB_REQUIRE_AUTH = '1';
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

// 写操作过跨源闸门（originCheck）：与 document.test.ts 同款，模拟合法前端源
const origin = 'http://localhost:5173';
const post = (url: string, cookie?: string) => {
  const r = request(app).post(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};
const get = (url: string, cookie?: string) => {
  const r = request(app).get(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};

/** 建统一账号 + 取会话 cookie（同 tenancy.test.ts 的 signUp 手法：直落账号层，不打 API） */
let userSeq = 0;
async function signUp(nickname: string): Promise<{ userId: string; nickname: string; cookie: string }> {
  const { createUser } = await import('../auth/users.js');
  const { createSession } = await import('../auth/session.js');
  const user = await createUser(`pk-auth-${++userSeq}@test.local`, 'good-password-1', nickname);
  const { token } = createSession(user.id);
  return { userId: user.id, nickname: user.nickname, cookie: `${AUTH_COOKIE_NAME}=${token}` };
}

describe('§14.1 旧登录端点已删除', () => {
  it('POST /api/pk/auth/login → 404（PK 不再有第二套登录，一律走 /api/auth/*）', async () => {
    // ★ 带合法会话打：排除全局鉴权闸门的 401 干扰，钉「路由本身不存在」
    const alice = await signUp('团子');
    const res = await post('/api/pk/auth/login', alice.cookie).send({ nickname: '团子' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/pk/auth/me（当前 PK 身份）', () => {
  it('未登录 → 401 UNAUTHENTICATED（语义本就是「没登录」，不再是当年清 localStorage 的 404）', async () => {
    const res = await get('/api/pk/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('登录后 → PkIdentity 即统一账号本身：userId = users.id、昵称取服务端库', async () => {
    const alice = await signUp('团子');
    const res = await get('/api/pk/auth/me', alice.cookie);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(alice.userId);
    expect(res.body.nickname).toBe('团子');
    // ★ 旧字段 openid 已随 mock 账号体系一起删掉，响应里不该再出现
    expect(res.body.openid).toBeUndefined();
  });
});

describe('会话身份 → 房间链路（端到端）', () => {
  it('凭 cookie 建房：房主身份就是会话用户，自报 userId/nickname 无效', async () => {
    const alice = await signUp('真名');
    const res = await post('/api/pk/rooms', alice.cookie).send({ userId: 'u-forge', nickname: '假名' });
    expect(res.status).toBe(201);
    const players = res.body.state.players as Array<{ userId: string; nickname: string }>;
    expect(players[0]?.userId).toBe(alice.userId);
    expect(players[0]?.nickname).toBe('真名');
  });
});

afterAll(() => {
  closeDb();
});
