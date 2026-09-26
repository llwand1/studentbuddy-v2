/**
 * routes/auth-demo — 公用体验账号端到端（契约 docs/AUTH-SPEC.md §2.10）。
 *
 * 钉死的是这个**零凭证端点**的承诺面：
 *  · 开关未开 = 端点等同不存在（404，且 users 表**零足迹**）；
 *  · 开着 = 200 + 与普通登录同构的会话 cookie，`/me` 认这条会话；
 *  · 所有访客汇到**同一行**（固定 id、表内恒一行）——幂等是体验账号的命根；
 *  · 响应体绝不带出 `password_hash`；密码登录对它永远 `CREDENTIALS_INVALID`；
 *  · 按 IP 限流：窗口内第 21 次 → 429（复用 TOO_MANY_ATTEMPTS）；
 *  · 写端点缺 Origin → 403（originCheck 对它一视同仁）。
 *
 * ⚠️ 限流是**进程内内存计数**，跨用例会串 ⇒ beforeEach 重置（同 `auth.test.ts` 的处置）。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import {
  AUTH_COOKIE_NAME,
  DEMO_LOGIN_MAX_PER_IP_HOUR,
  DEMO_USER_ID,
  DEMO_USER_NICKNAME,
} from '@sb/shared';

const { app, request, getDb, closeDb } = await boot('auth-demo-test');
const origin = TEST_ORIGIN;

const { resetDemoLoginLimits } = await import('../auth/demo.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');

const post = (url: string) => request(app).post(url).set('Origin', origin);

function demoRowCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?').get(DEMO_USER_ID) as { c: number }).c;
}

beforeEach(() => {
  resetDemoLoginLimits();
  resetRateLimits();
  delete process.env.SB_DEMO_LOGIN;
});

afterEach(() => {
  delete process.env.SB_DEMO_LOGIN;
});

afterAll(() => {
  closeDb();
});

describe('开关未开（本地/未配置部署）', () => {
  it('POST /demo-login → 404，users 表零足迹（不惰性建号）', async () => {
    const res = await post('/api/auth/demo-login').send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DEMO_DISABLED');
    expect(demoRowCount()).toBe(0);
  });

  it('/providers 的 demo 字段为 false（前端据此不画入口）', async () => {
    const res = await request(app).get('/api/auth/providers');
    expect(res.body.providers.demo).toBe(false);
  });

  it('★ 开关未开时**种子内容也不落**：体验号在 `term_library` 里同样零足迹', async () => {
    // 防的是将来有人把 `tryEnsureDemoSeed()` 挪到建号处/启动时——那会让未配置的部署凭空多出八条词条
    await post('/api/auth/demo-login').send({});
    const c = (
      getDb().prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ?').get(DEMO_USER_ID) as { c: number }
    ).c;
    expect(c).toBe(0);
  });
});

describe('开关打开（SB_DEMO_LOGIN=1，仅生产）', () => {
  it('200 + 固定身份 + 会话 cookie 下发；响应体不含 password_hash', async () => {
    process.env.SB_DEMO_LOGIN = '1';
    const res = await post('/api/auth/demo-login').send({});
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(DEMO_USER_ID);
    expect(res.body.user.nickname).toBe(DEMO_USER_NICKNAME);
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=`);
  });

  it('体验会话被 /me 认账（与普通登录同一种会话，归属逻辑零分支）', async () => {
    process.env.SB_DEMO_LOGIN = '1';
    const res = await post('/api/auth/demo-login').send({});
    const sid = (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    const me = await request(app).get('/api/auth/me').set('Cookie', sid).expect(200);
    expect(me.body.user.id).toBe(DEMO_USER_ID);
  });

  it('重复进入汇到同一行（表内恒一行、id 相同）', async () => {
    process.env.SB_DEMO_LOGIN = '1';
    const a = await post('/api/auth/demo-login').send({});
    const b = await post('/api/auth/demo-login').send({});
    expect(b.body.user.id).toBe(a.body.user.id);
    expect(demoRowCount()).toBe(1);
  });

  it('密码登录对体验账号永远 CREDENTIALS_INVALID（口令不可知的锁死）', async () => {
    process.env.SB_DEMO_LOGIN = '1';
    await post('/api/auth/demo-login').send({});
    const res = await post('/api/auth/login').send({
      email: 'shared-demo@studentbuddy.invalid',
      password: 'whatever-1234',
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('CREDENTIALS_INVALID');
  });

  it('同 IP 限流：第 ' + (DEMO_LOGIN_MAX_PER_IP_HOUR + 1) + ' 次 → 429 TOO_MANY_ATTEMPTS', async () => {
    process.env.SB_DEMO_LOGIN = '1';
    let last = 200;
    for (let i = 0; i <= DEMO_LOGIN_MAX_PER_IP_HOUR; i += 1) {
      const res = await post('/api/auth/demo-login').send({});
      last = res.status;
      if (last === 429) {
        expect(res.body.code).toBe('TOO_MANY_ATTEMPTS');
        expect(i).toBe(DEMO_LOGIN_MAX_PER_IP_HOUR); // 前 20 次都必须放行，不许更早误伤
        return;
      }
      expect(last).toBe(200);
    }
    expect(last).toBe(429); // 循环没提前 return 也没 429 ⇒ 限流没生效，让它红在这里
  });

  it('缺 Origin 的跨源调用 → 403（originCheck 不因“免凭证”而豁免）', async () => {
    process.env.SB_DEMO_LOGIN = '1';
    await request(app).post('/api/auth/demo-login').set('Origin', 'https://evil.example.com').send({}).expect(403);
  });

  it('/providers 的 demo 字段翻转为 true', async () => {
    process.env.SB_DEMO_LOGIN = '1';
    const res = await request(app).get('/api/auth/providers');
    expect(res.body.providers.demo).toBe(true);
  });
});
