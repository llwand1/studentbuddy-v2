/**
 * routes/pk 本地形态兜底身份（B1 §14.1 / AUTH-SPEC §2.9，2026-09-20 新增）。
 *
 * ★ PK 改造后身份恒走统一账号会话；但 `local` 形态（SB_REQUIRE_AUTH 未设，本机单人）
 *   一直是「免登录可用」——`pkIdentityOf` 在无会话时回 `PK_LOCAL_IDENTITY`。
 *   本文件**不开强制鉴权**，钉住这条兜底语义不被后续误伤：
 *   未登录可查身份、可建房；且所有无会话请求是**同一个**兜底身份（本地单人的既定边界，
 *   本地形态本来就不支撑两个不同玩家——要真对战请登录，走 cloud 形态）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import { PK_LOCAL_IDENTITY } from '@sb/shared';

delete process.env.SB_REQUIRE_AUTH;
const { app, request, closeDb } = await boot('pk-local-test');
const origin = TEST_ORIGIN;

const { resetRooms } = await import('../pk/room.js');

const post = (url: string) => request(app).post(url).set('Origin', origin);
const get = (url: string) => request(app).get(url).set('Origin', origin);

describe('local 形态：无会话 → PK_LOCAL_IDENTITY 兜底（免登录可用）', () => {
  it('/auth/me 无 cookie → 兜底身份', async () => {
    const res = await get('/api/pk/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(PK_LOCAL_IDENTITY);
  });

  it('未登录可建房（本地单人模式）', async () => {
    resetRooms();
    const res = await post('/api/pk/rooms').send({});
    expect(res.status).toBe(201);
    expect((res.body.state as { players: Array<{ userId: string }> }).players[0]?.userId).toBe(
      PK_LOCAL_IDENTITY.userId,
    );
  });

  it('两次无会话请求是同一个兜底身份（重复建房幂等＝同一间房）', async () => {
    resetRooms();
    const a = await post('/api/pk/rooms').send({});
    const b = await post('/api/pk/rooms').send({});
    expect(b.body.roomId).toBe(a.body.roomId);
  });
});

afterAll(() => {
  closeDb();
});
