/**
 * routes/auth 端到端（supertest，同 `routes/pk-auth.test.ts` 手法）。
 *
 * 钉死契约 docs/AUTH-SPEC.md §2 的**可观测承诺**，而不是复述实现：
 *  · register 建号 + 直接下发会话 cookie，响应体**绝不含 password_hash**；
 *  · 邮箱归一化（大小写/空白不建重复账号）；
 *  · 失败码语义（409 占用 / 400 弱口令 / 401 凭据错 / 429 限流）；
 *  · 会话闭环：cookie → /me 200；logout → /me 401；
 *  · 写端点缺 Origin → 403（`security.ts` 的 originCheck，跨源闸门）。
 *
 * ⚠️ 限流与「时序均衡哈希缓存」是**进程内模块状态**，跨用例会串——故 beforeEach 一律重置。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, AUTH_MAX_LOGIN_FAILURES } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-auth-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetAuthCaches } = await import('../auth/users.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const post = (url: string) => request(app).post(url).set('Origin', origin);
const get = (url: string) => request(app).get(url).set('Origin', origin);

/** 从响应头里取出会话 cookie 的 `name=value` 段（供后续请求用）。 */
function sidCookie(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const hit = arr.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  return hit ? (hit.split(';')[0] ?? '') : '';
}

/** 注册一个账号，返回响应 + 会话 cookie。 */
async function register(email: string, password = 'good-password-1', nickname?: string) {
  const res = await post('/api/auth/register').send({ email, password, nickname });
  return { res, cookie: sidCookie(res.headers) };
}

beforeEach(() => {
  resetRateLimits();
  resetAuthCaches();
});

describe('POST /api/auth/register（契约 §2）', () => {
  it('建号 + 直接下发会话 cookie；响应体含 user 四字段且**不含 password_hash**', async () => {
    const { res, cookie } = await register('Alice@Example.COM');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com' }); // 归一化：转小写
    expect(res.body.user.nickname).toBe('alice'); // 未传昵称 → 从邮箱派生
    expect(typeof res.body.user.id).toBe('string');
    expect(typeof res.body.user.createdAt).toBe('string');

    // ★ 契约层不给「不小心下发凭据」留口子
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(res.body)).not.toContain('scrypt$');

    // 会话 cookie：httpOnly + 同名
    const raw = res.headers['set-cookie'] as unknown as string[];
    const sid = raw.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))!;
    expect(sid).toContain('HttpOnly');
    expect(cookie).not.toBe('');
  });

  it('显式昵称生效（trim 后落库）', async () => {
    const { res } = await register('nick@example.com', 'good-password-1', '  小明  ');
    expect(res.body.user.nickname).toBe('小明');
  });

  it('重复邮箱（含大小写变体）→ 409 EMAIL_TAKEN', async () => {
    await register('dup@example.com');
    const again = await post('/api/auth/register').send({ email: 'DUP@Example.com', password: 'good-password-1' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['非法邮箱', { email: 'not-an-email', password: 'good-password-1' }, 400, 'EMAIL_INVALID'],
    ['弱口令（<8）', { email: 'weak@example.com', password: 'short' }, 400, 'PASSWORD_WEAK'],
    ['超长口令（>100）', { email: 'long@example.com', password: 'a'.repeat(101) }, 400, 'PASSWORD_WEAK'],
    ['昵称超 20 字', { email: 'nn@example.com', password: 'good-password-1', nickname: '一'.repeat(21) }, 400, 'NICKNAME_INVALID'],
  ])('%s → %s %s，且不落库', async (_label, body, status, code) => {
    const before = (await import('../storage/db.js')).getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    const res = await post('/api/auth/register').send(body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    const after = (await import('../storage/db.js')).getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    expect(after.c).toBe(before.c);
  });
});

describe('POST /api/auth/login（契约 §2 + §4.4 限流）', () => {
  it('正确凭据 → 200 + 新会话 cookie', async () => {
    await register('login@example.com', 'good-password-1');
    const res = await post('/api/auth/login').send({ email: 'login@example.com', password: 'good-password-1' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('login@example.com');
    expect(sidCookie(res.headers)).not.toBe('');
  });

  it('邮箱不存在与密码错**回同一个码**（不泄露账号是否存在）', async () => {
    await register('exists@example.com', 'good-password-1');
    const wrongPw = await post('/api/auth/login').send({ email: 'exists@example.com', password: 'wrong-password' });
    const noSuch = await post('/api/auth/login').send({ email: 'ghost@example.com', password: 'wrong-password' });
    expect(wrongPw.status).toBe(401);
    expect(noSuch.status).toBe(401);
    expect(wrongPw.body.code).toBe('CREDENTIALS_INVALID');
    expect(noSuch.body.code).toBe('CREDENTIALS_INVALID');
  });

  it(`连续失败 ${AUTH_MAX_LOGIN_FAILURES} 次后 → 429 TOO_MANY_ATTEMPTS（防撞库）`, async () => {
    await register('lock@example.com', 'good-password-1');
    for (let i = 0; i < AUTH_MAX_LOGIN_FAILURES; i += 1) {
      const r = await post('/api/auth/login').send({ email: 'lock@example.com', password: 'nope-nope-nope' });
      expect(r.status).toBe(401);
    }
    const locked = await post('/api/auth/login').send({ email: 'lock@example.com', password: 'good-password-1' });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('登录成功后失败计数清零（不会攒着把正常用户锁死）', async () => {
    await register('clear@example.com', 'good-password-1');
    for (let i = 0; i < AUTH_MAX_LOGIN_FAILURES - 1; i += 1) {
      await post('/api/auth/login').send({ email: 'clear@example.com', password: 'bad-bad-bad-bad' });
    }
    const ok = await post('/api/auth/login').send({ email: 'clear@example.com', password: 'good-password-1' });
    expect(ok.status).toBe(200);
    // 清零后再失败 4 次仍未锁（若没清零，此时已累计 8 次必锁）
    for (let i = 0; i < AUTH_MAX_LOGIN_FAILURES - 1; i += 1) {
      const r = await post('/api/auth/login').send({ email: 'clear@example.com', password: 'bad-bad-bad-bad' });
      expect(r.status).toBe(401);
    }
  });
});

describe('GET /api/auth/me + POST /api/auth/logout（会话闭环）', () => {
  it('注册拿到的 cookie 可直接查 /me；登出后同一 cookie → 401', async () => {
    const { res: reg, cookie } = await register('me@example.com');
    expect(cookie).not.toBe('');

    const me = await get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(reg.body.user);

    const out = await post('/api/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);

    const after = await get('/api/auth/me').set('Cookie', cookie);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('UNAUTHENTICATED');
  });

  it('支持 Authorization: Bearer（给真机冒烟/脚本用）', async () => {
    const { cookie } = await register('bearer@example.com');
    const token = cookie.slice(`${AUTH_COOKIE_NAME}=`.length);
    const me = await get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('bearer@example.com');
  });

  it('未登录访问 /me → 401 UNAUTHENTICATED；登出幂等（未登录也回 200）', async () => {
    const me = await get('/api/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('UNAUTHENTICATED');

    const out = await post('/api/auth/logout');
    expect(out.status).toBe(200);
  });
});

describe('写端点跨源闸门（security.ts originCheck）', () => {
  it('无 Origin 的 register → 403（不是参数错误）', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'x@y.com', password: 'good-password-1' });
    expect(res.status).toBe(403);
  });

  it('非白名单 Origin 的 login → 403', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example.com')
      .send({ email: 'x@y.com', password: 'good-password-1' });
    expect(res.status).toBe(403);
  });
});

afterAll(() => {
  closeDb();
});
