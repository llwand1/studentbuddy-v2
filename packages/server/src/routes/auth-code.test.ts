/**
 * routes/auth 验证码端点端到端（supertest，契约 docs/AUTH-SPEC.md §2.5 / §4.5）。
 *
 * ★ 与 `routes/auth.test.ts`（账号四端点）**刻意分文件**：两条登录通道是两个批次的东西，
 *   混在一份里改一处就要重读另一处；且本仓有多会话并行施工的历史（R1/R6），
 *   新端点新文件能把冲突面压到零。
 *
 * ★ 本文件守的两条最要紧承诺：
 *   ① `login-by-code` **产出与密码登录完全相同的会话**（同一个 cookie、同一个 `/me`）——
 *      "两套登录方式、一种会话"是 TENANCY-SPEC 全部归属逻辑不必分支的前提；
 *   ② `send-code` 在 `login` 态**对注册与否回逐字相同的响应**（用户枚举防线）。
 *
 * ★ 2026-09-18（M1.6，契约 §2.7）：`register` 用途**已接线**，本文件补三条端点级用例：
 *   · 未注册 ⇒ 真发一封（注册流程的第一步）；
 *   · 已注册 ⇒ 409 `EMAIL_TAKEN`（刻意泄露，与 `login` 态口径相反）；
 *   · **register 的 IP 桶更严（5/小时）且与 login 分桶**——后者是校园网下最容易被误伤的一处。
 *
 * ★ 发信一律打桩（`setMailSender`）：绝不真发信——会烧 Resend 额度、还会给真人发邮件。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_CODE_MAX_PER_IP_REGISTER_HOUR, AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-routes-auth-code-test-'));
const { app } = await import('../index.js');
const { getDb } = await import('../storage/db.js');
const { resetCodeLimits } = await import('../auth/code-limit.js');
const { setMailSender } = await import('../mail/send.js');
const { createUser, resetAuthCaches } = await import('../auth/users.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const post = (url: string) => request(app).post(url).set('Origin', origin);

const sent: Array<{ to: string; subject: string; text: string }> = [];

/** 从响应头取会话 cookie 的 `name=value` 段。 */
function sidCookie(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return arr.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))?.split(';')[0] ?? '';
}

/** 从最近一封邮件取验证码（正文首行）。 */
function lastCode(): string {
  const last = sent[sent.length - 1];
  if (!last) throw new Error('预期有发信，实际一封都没发');
  return last.text.split('\n')[0] ?? '';
}

/**
 * 造一个**已注册账号**当夹具。
 *
 * ★ 刻意**不走 `POST /api/auth/register`**（虽然 M1.6 起它是一条真实路径）：
 *   注册流程会先真发一封注册码，占掉该邮箱在 `register` 用途上的 60 秒最小间隔与 1 个每小时名额；
 *   而本文件的主体是 `send-code` / `login-by-code` **这两个端点**，
 *   每条用例再叠一层注册流程的配额，就会让「注册流程改阈值」连带打红这个文件。
 *   ⇒ 夹具直接落库（`createUser`），把被测端点留在**干净配额**下。
 *   注册端点本身的完整覆盖在 `routes/auth.test.ts`。
 */
async function seedUser(email: string): Promise<void> {
  await createUser(email, 'good-password-1', undefined);
}

beforeEach(() => {
  // ★ 账号也要清：同一邮箱在多个用例里注册，不清就会撞 `UNIQUE(email)` 拿 409
  //   （症状是"注册返回 409"看着像产品 bug，其实是测试自己没隔离）
  getDb().prepare('DELETE FROM auth_codes').run();
  getDb().prepare('DELETE FROM auth_sessions').run();
  getDb().prepare('DELETE FROM users').run();
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

describe('POST /api/auth/send-code（契约 §2.5）', () => {
  it('已注册 + purpose=login ⇒ 200 `{ ok, expiresInMs }`，且**真的发了一封**', async () => {
    await seedUser('member@example.com');
    const res = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.expiresInMs).toBe('number');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('member@example.com');
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it('★ 未注册 + purpose=login ⇒ **响应体逐字段相同**，但一封不发（用户枚举防线）', async () => {
    await seedUser('member@example.com');
    const known = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    const ghost = await post('/api/auth/send-code').send({ email: 'nobody@example.com', purpose: 'login' });
    expect(ghost.status).toBe(known.status);
    expect(ghost.body).toEqual(known.body);
    expect(sent).toHaveLength(1); // 只有已注册那封真发了
  });

  it('邮箱非法 → 400 `EMAIL_INVALID`；用途未接线 → 400 `PURPOSE_INVALID`（错误形状带人话）', async () => {
    const bad = await post('/api/auth/send-code').send({ email: 'not-an-email', purpose: 'login' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('EMAIL_INVALID');
    expect(typeof bad.body.error).toBe('string');

    // ★ M1.6 起 `register` **已接线**，不在这一组里；`reset` 仍未接线（密码找回端点未做）
    for (const purpose of ['reset', 'signup', undefined]) {
      const res = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PURPOSE_INVALID');
    }
    expect(sent).toHaveLength(0);
  });

  it('★ `register` 已接线：未注册地址 ⇒ 200 且**真的发了一封**（这就是注册流程的第一步）', async () => {
    const res = await post('/api/auth/send-code').send({ email: 'newbie@example.com', purpose: 'register' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('newbie@example.com');
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it('★ `register` 对**已注册**地址 → 409 `EMAIL_TAKEN`（刻意泄露：填错邮箱要当场知道）', async () => {
    await seedUser('member@example.com');
    const again = await post('/api/auth/send-code').send({ email: 'MEMBER@Example.com', purpose: 'register' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('EMAIL_TAKEN');
    expect(sent).toHaveLength(0); // 被拒的请求一封都没发
  });

  it('★ `register` 的 IP 上限**更严**（5/小时）：同一出口 IP 第 6 个地址 → 429', async () => {
    // 这是**产品可见**的承诺，也是校园网/公司网下真会被撞到的那个数
    // （诚实记账见 `shared/src/auth.ts` 的 `AUTH_CODE_MAX_PER_IP_REGISTER_HOUR`）。
    // `code-limit.test.ts` 钉的是限流器本身；这条钉的是「端点真的接上了那条更严的线」。
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_REGISTER_HOUR; i += 1) {
      const res = await post('/api/auth/send-code').send({ email: `fresh${i}@example.com`, purpose: 'register' });
      expect(res.status).toBe(200);
    }
    const sixth = await post('/api/auth/send-code').send({ email: 'fresh6@example.com', purpose: 'register' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('CODE_RATE_LIMITED');
    expect(sent).toHaveLength(AUTH_CODE_MAX_PER_IP_REGISTER_HOUR);
  });

  it('★★ 注册被刷满**不会**掐死同一出口 IP 上的验证码登录（**分桶的全部理由**）', async () => {
    // 两个用途共用一个 IP 桶的话，「有人拿 register 刷满」会连带掐死
    // 同一出口 IP 上所有人的验证码登录 —— 校园网 / 公司网 / 运营商 NAT 全中招。
    // 这条用例守的就是那个决定：IP 桶的键是 `${purpose}:${ip}`。
    await seedUser('member@example.com'); // 夹具直接落库 ⇒ 不占 register 用途的任何名额
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_REGISTER_HOUR; i += 1) {
      await post('/api/auth/send-code').send({ email: `spam${i}@example.com`, purpose: 'register' });
    }
    const blocked = await post('/api/auth/send-code').send({ email: 'more@example.com', purpose: 'register' });
    expect(blocked.status).toBe(429); // register 桶确实满了

    const login = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    expect(login.status).toBe(200); // ★ login 的 IP 名额没被 register 吃掉
  });

  it('连点 → 429 `CODE_RATE_LIMITED`，且**第二封不发**', async () => {
    await seedUser('member@example.com');
    await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    const again = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('CODE_RATE_LIMITED');
    expect(sent).toHaveLength(1);
  });

  it('发信通道故障 → 502 `MAIL_SEND_FAILED`（**不让用户干等**，文案能指路）', async () => {
    await seedUser('member@example.com');
    setMailSender({ name: 'boom', send: () => Promise.reject(new Error('resend http 500')) });
    const res = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('MAIL_SEND_FAILED');
    expect(String(res.body.error)).toContain('密码登录'); // 兜底路径要写在文案里
  });

  it('缺 Origin → 403（`security.ts` 的跨源写闸门，**不是**参数错误）', async () => {
    const res = await request(app).post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/login-by-code（契约 §2.5）', () => {
  it('★★ 正确码 ⇒ 200 `{ user }` + Set-Cookie，且该 cookie 能查 `/me`——**与密码登录产出同一种会话**', async () => {
    await seedUser('member@example.com');
    await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });

    const res = await post('/api/auth/login-by-code').send({ email: 'member@example.com', code: lastCode() });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('member@example.com');
    expect(res.body.user).not.toHaveProperty('password_hash');

    const cookie = sidCookie(res.headers);
    expect(cookie).not.toBe('');
    const raw = res.headers['set-cookie'] as unknown as string[];
    expect(raw.find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`))).toContain('HttpOnly');

    // ★ 会话是同一个机制：拿它查 /me 必须与响应体逐字段相等
    const me = await request(app).get('/api/auth/me').set('Origin', origin).set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(res.body.user);
  });

  it('码错 → 400 `CODE_INVALID`；同一个码用第二次 → 400（**一次性**）', async () => {
    await seedUser('member@example.com');
    await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    const code = lastCode();

    const wrong = await post('/api/auth/login-by-code').send({ email: 'member@example.com', code: '000000' === code ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('CODE_INVALID');

    expect((await post('/api/auth/login-by-code').send({ email: 'member@example.com', code })).status).toBe(200);
    const replay = await post('/api/auth/login-by-code').send({ email: 'member@example.com', code });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('CODE_INVALID');
  });

  it('码过期 → 400 `CODE_EXPIRED`（与 `CODE_INVALID` 分开：用户动作不同，重发 vs 重输）', async () => {
    await seedUser('member@example.com');
    await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    // 端点内部取 `Date.now()`，无法注入时间 ⇒ 直接把库里那条码推到过去
    getDb().prepare(`UPDATE auth_codes SET expires_at = ? WHERE consumed_at IS NULL`).run(Date.now() - 1);

    const res = await post('/api/auth/login-by-code').send({ email: 'member@example.com', code: lastCode() });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CODE_EXPIRED');
  });

  it('未注册邮箱 → 401 `CREDENTIALS_INVALID`（与密码登录同一个码），**不自动建号**', async () => {
    // 造一条"码存在但账号不存在"的状态：直插一行码（`send-code` 在 login 态对未注册是静默的）
    const { issueCode } = await import('../auth/codes.js');
    const { code } = issueCode('ghost@example.com', 'login');
    const res = await post('/api/auth/login-by-code').send({ email: 'ghost@example.com', code });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('CREDENTIALS_INVALID');
    expect((getDb().prepare(`SELECT COUNT(*) AS c FROM users WHERE email = 'ghost@example.com'`).get() as { c: number }).c).toBe(0);
  });

  it('邮箱大小写 / 空白不影响（两端共用同一份归一化）', async () => {
    await seedUser('member@example.com');
    await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    const res = await post('/api/auth/login-by-code').send({ email: '  MEMBER@Example.COM  ', code: ` ${lastCode()} ` });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('member@example.com');
  });

  it('缺 Origin → 403', async () => {
    const res = await request(app).post('/api/auth/login-by-code').send({ email: 'member@example.com', code: '123456' });
    expect(res.status).toBe(403);
  });
});
