/**
 * routes/auth-require — **M2 收口**的部署形态验证（契约 docs/AUTH-SPEC.md §3、launch-plan §3.1 五条代码闸门）。
 *
 * ★ 与其他测试文件的本质区别：本文件在 import `index.js` **之前**把四个部署 env 一次性设好——
 *   `SB_REQUIRE_AUTH=1` / `SB_COOKIE_SECURE=1` / `SB_TRUST_PROXY=1` / `SB_ALLOWED_ORIGINS=...`。
 *   它验证的不是"某个函数算得对"，而是**「上线那一刻整个 app 在生产开关下是否还站得住」**：
 *   强制鉴权全站 401 但豁免清单照常公开、登录链路不受影响、部署域名进 Origin 白名单、
 *   cookie 带 Secure、反代信任已接线。vitest 按文件隔离进程 ⇒ 这些 env 不会泄漏进别的测试文件。
 *
 * ★ 本文件刻意**不测** Express 的 `trust proxy` 解析语义（那是 express 的单测范围）——
 *   本仓要锁的是「env 配了、`app.set` 真的收到了」（接线锁，漏接的形态是"配置了却永不生效"，
 *   与 §0.15 收敛计数那族「写错不报错」同型）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_COOKIE_SECURE = '1';
process.env.SB_TRUST_PROXY = '1';
process.env.SB_ALLOWED_ORIGINS = 'https://sb.example.com';

const { app, request, closeDb } = await boot('auth-require', { requireAuth: true });
const origin = TEST_ORIGIN;

const { createUser } = await import('../auth/users.js');
const { createSession } = await import('../auth/session.js');

const depOrigin = 'https://sb.example.com';

afterAll(() => {
  closeDb();
});

describe('SB_REQUIRE_AUTH=1（强制鉴权，闸门 5）', () => {
  it('未登录读业务接口 → 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get('/api/sessions').set('Origin', origin).expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('未登录写业务接口 → 401（Origin 合法时先过 origin 门、再被 auth 拦）', async () => {
    const res = await request(app)
      .post('/api/terms')
      .set('Origin', origin)
      .send({ term: 'x', definition: 'y' })
      .expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('豁免清单照常公开：status / health / auth/* 不要求登录（登录端点自己不能要求登录）', async () => {
    await request(app).get('/api/status').expect(200);
    await request(app).get('/api/health').expect(200);
    // login 端点必须可执行：错口令进到域层校验（CREDENTIALS_INVALID），而不是被自己的 401 闸拦下
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email: 'nobody@example.com', password: 'wrong-password' });
    expect(res.body.code).toBe('CREDENTIALS_INVALID');
  });

  it('本进程 SB_REQUIRE_AUTH=1 ⇒ /providers 的 form 必须是 cloud（形态与闸门同源，契约 AUTH-SPEC §2.9）', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body.form).toBe('cloud');
  });

  it('登录用户一切照旧：合法会话读业务接口 200', async () => {
    const user = await createUser('require-auth@example.com', 'good-password-1', undefined);
    const { token } = createSession(user.id);
    const res = await request(app)
      .get('/api/sessions')
      .set('Origin', origin)
      .set('Cookie', `${AUTH_COOKIE_NAME}=${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('SB_ALLOWED_ORIGINS（部署域名白名单，闸门 2）', () => {
  it('配置里的部署域名：POST 过 origin 门（错误进到业务层，不是 403）', async () => {
    const res = await request(app).post('/api/auth/login').set('Origin', depOrigin).send({ email: 'x@y.z', password: 'nope-nope' });
    expect(res.status).not.toBe(403);
  });

  it('不在白名单的外部域名：POST → 403（本地兜底正则没有放宽）', async () => {
    await request(app).post('/api/auth/login').set('Origin', 'https://evil.example.com').send({}).expect(403);
  });
});

describe('SB_COOKIE_SECURE=1（闸门 4）与 SB_TRUST_PROXY=1（闸门 1）', () => {
  it('登录下发的 Set-Cookie 带 Secure 标记（HTTPS 站点不配就等于明文送会话）', async () => {
    const email = 'secure-cookie@example.com';
    await createUser(email, 'good-password-1', undefined);
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email, password: 'good-password-1' })
      .expect(200);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toContain('Secure');
  });

  it('接线锁：SB_TRUST_PROXY=1 → app.set("trust proxy") 真的收到了 1（漏接 = 配置永不生效）', () => {
    expect(app.get('trust proxy')).toBe(1);
  });
});
