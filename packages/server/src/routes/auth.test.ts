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
 * ★ 2026-09-18（M1.6，契约 §2.7「注册即验证」）：`/register` 的入参**多了必填的 `code`**。
 *   本文件的 `register()` 辅助函数随之改成**走完整流程**（发注册码 → 用码注册）——
 *   这是刻意的：让每个用例都顺手把新链路跑一遍，而不是绕过它直插账号。
 *   ★ 新增两条用例守的正是「后门必须消失」与「兜底必须是 409 而不是 500」。
 *
 * ⚠️ 限流与「时序均衡哈希缓存」是**进程内模块状态**，跨用例会串——故 beforeEach 一律重置。
 *   ★ 验证码限流（`code-limit.ts`）也必须重置：注册的 IP 桶上限只有 **5/小时**，
 *     而本文件有 9 处 `register()`，全走同一个出口 IP ⇒ 不重置的话第 6 个用例起必吃 429。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, AUTH_MAX_LOGIN_FAILURES } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-auth-test-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { resetRateLimits } = await import('../auth/rate-limit.js');
const { resetCodeLimits } = await import('../auth/code-limit.js');
const { resetAuthCaches } = await import('../auth/users.js');
const { setMailSender } = await import('../mail/send.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const post = (url: string) => request(app).post(url).set('Origin', origin);
const get = (url: string) => request(app).get(url).set('Origin', origin);

/** 桩发信收集器（**绝不真发**：会烧 Resend 额度、还会给真人发邮件）。 */
const sent: Array<{ to: string; subject: string; text: string }> = [];

/** 从最近一封邮件取验证码（`buildCodeMail` 把码单独放在首行，就是为了这一眼能抄到）。 */
function lastCode(): string {
  const last = sent[sent.length - 1];
  if (!last) throw new Error('预期有发信，实际一封都没发');
  return last.text.split('\n')[0] ?? '';
}

/** 当前用户数（用于断言"失败请求不落库"）。 */
function userCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
}

/** 从响应头里取出会话 cookie 的 `name=value` 段（供后续请求用）。 */
function sidCookie(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const hit = arr.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
  return hit ? (hit.split(';')[0] ?? '') : '';
}

/**
 * 注册一个账号，返回响应 + 会话 cookie。
 * ★ M1.6 起必须先发码再注册（§2.7）——这里把两步封在一起，用例只管调它。
 */
async function register(email: string, password = 'good-password-1', nickname?: string) {
  const asked = await post('/api/auth/send-code').send({ email, purpose: 'register' });
  if (asked.status !== 200) {
    throw new Error(`发注册码失败（${asked.status}）：${JSON.stringify(asked.body)}`);
  }
  const res = await post('/api/auth/register').send({ email, code: lastCode(), password, nickname });
  return { res, cookie: sidCookie(res.headers) };
}

beforeEach(() => {
  resetRateLimits();
  resetCodeLimits();
  resetAuthCaches();
  sent.length = 0;
  setMailSender({
    name: 'test',
    send: (msg) => {
      sent.push(msg);
      return Promise.resolve();
    },
  });
});

describe('POST /api/auth/register（契约 §2 + §2.7 注册即验证）', () => {
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

  it('★★ 不传 `code` 的注册 → 400 `CODE_INVALID`，且**不落库**（旧的无码注册路径必须已消失）', async () => {
    // 这条是本批最要紧的回归防线：无码注册若还能建号，M1.6 等于没做，
    // 而且它不是一个"兼容性入口"，是**绕过邮箱验证的后门**。
    const before = userCount();
    const res = await post('/api/auth/register').send({ email: 'nocode@example.com', password: 'good-password-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CODE_INVALID');
    expect(userCount()).toBe(before);
  });

  it('★ 拿 `login` 用途的码去注册 → 400 `CODE_INVALID`（两个用途的码在库里是两条记录）', async () => {
    await register('purp@example.com');
    await post('/api/auth/send-code').send({ email: 'purp@example.com', purpose: 'login' });
    const before = userCount();

    const res = await post('/api/auth/register').send({
      email: 'purp@example.com',
      code: lastCode(), // 这是 login 码，不是 register 码
      password: 'good-password-1',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CODE_INVALID');
    expect(userCount()).toBe(before);
  });

  it('重复邮箱：**发注册码当场 409 `EMAIL_TAKEN`**（§2.7 第一道闸，用户填错邮箱要立刻知道）', async () => {
    // ★ 直接落库造账号，**不走注册流程**：走的话会先真发一封注册码，
    //   而「同一邮箱 + 同一用途」的 60 秒最小间隔会把下面这次发码拦成 429
    //   ——那是另一条闸（`code-limit.ts`），不是本用例要验的东西。
    const { createUser } = await import('../auth/users.js');
    await createUser('dup@example.com', 'good-password-1', undefined);
    const again = await post('/api/auth/send-code').send({ email: 'DUP@Example.com', purpose: 'register' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EMAIL_TAKEN');
  });

  it('★ 库层唯一约束是**最终兜底**：直插一条 `register` 码再注册已占用邮箱 → 409（**不是 500**）', async () => {
    // 正常流程里 `send-code` 已先回 409，走不到这里；但并发下两个请求可能都拿到码，
    // ⇒ 第二个人建号时必须撞到 `users.email UNIQUE`。撞了要**翻译成 409**，
    //   原样漏出去就是 500（"服务器错误"看着像我们挂了，其实是可预期的业务冲突）。
    await register('dup2@example.com');
    const { issueCode } = await import('../auth/codes.js');
    const { code } = issueCode('dup2@example.com', 'register');
    const res = await post('/api/auth/register').send({
      email: 'dup2@example.com',
      code,
      password: 'good-password-1',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['非法邮箱', { email: 'not-an-email', password: 'good-password-1' }, 400, 'EMAIL_INVALID'],
    ['弱口令（<8）', { email: 'weak@example.com', password: 'short' }, 400, 'PASSWORD_WEAK'],
    ['超长口令（>100）', { email: 'long@example.com', password: 'a'.repeat(101) }, 400, 'PASSWORD_WEAK'],
    ['昵称超 20 字', { email: 'nn@example.com', password: 'good-password-1', nickname: '一'.repeat(21) }, 400, 'NICKNAME_INVALID'],
  ])('%s → %s %s，且不落库', async (_label, body, status, code) => {
    const before = userCount();
    const res = await post('/api/auth/register').send(body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(userCount()).toBe(before);
  });

  it('★ 纯校验失败**不烧码**：手滑打成弱口令后，同一个码还能用来注册（校验在核销之前）', async () => {
    // 顺序（`code-flow.ts` `registerByCode`）：纯校验 → 核销码 → 建号。
    // 反过来的话，用户"密码只打了 6 位"这种手滑会白烧一条码，得重新收信。
    await post('/api/auth/send-code').send({ email: 'order@example.com', purpose: 'register' });
    const code = lastCode();

    const weak = await post('/api/auth/register').send({ email: 'order@example.com', code, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('PASSWORD_WEAK');

    const ok = await post('/api/auth/register').send({ email: 'order@example.com', code, password: 'good-password-1' });
    expect(ok.status).toBe(200); // ★ 码没被那次失败吃掉
    expect(ok.body.user.email).toBe('order@example.com');
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
