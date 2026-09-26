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
 * ★ 2026-09-18（M1.6，§2.7）曾为**已接线的 `register` 用途**补三条端点级用例；
 *   ★ **2026-09-22 该契约作废**（注册免码）⇒ 没有消费端点的发码用途必须同批摘线
 *   （留着它＝拿我们的通道给任意陌生邮箱发信：烧 Resend 日额度 + 发信域名被拉黑）。
 *   本文件随之改成钉四件事：`register` 态一律 400 且零发信零落码、**脏请求不占限流名额**、
 *   `login` 的 IP 桶端点级仍生效（★★ 含 `retryAfterMs` 到达响应体那条真机逼出来的锁，一字未松）、
 *   摘线之后 register 不再有机会挤占 login 的名额。
 *
 * ★ 发信一律打桩（`setMailSender`）：绝不真发信——会烧 Resend 额度、还会给真人发邮件。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import { AUTH_CODE_MAX_PER_IP_HOUR, AUTH_CODE_RESEND_INTERVAL_MS, AUTH_CODE_WINDOW_MS, AUTH_COOKIE_NAME } from '@sb/shared';

const { app, request, getDb } = await boot('routes-auth-code-test');
const origin = TEST_ORIGIN;

const { resetCodeLimits } = await import('../auth/code-limit.js');
const { setMailSender } = await import('../mail/send.js');
const { createUser, resetAuthCaches } = await import('../auth/users.js');

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

    // ★ 2026-09-22 起 `register` 与 `reset` **同档都未接线**（注册免码 ⇒ 消费端点消失）
    for (const purpose of ['register', 'reset', 'signup', undefined]) {
      const res = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PURPOSE_INVALID');
    }
    expect(sent).toHaveLength(0);
  });

  it('★★ `register` 用途已摘线 → 400 `PURPOSE_INVALID`，**一封不发、一行码不落库**', async () => {
    // 与作废前的**相反**承诺，留痕在此：原先这条是「未注册 ⇒ 200 且真发一封（注册第一步）」、
    // 「已注册 ⇒ 409 EMAIL_TAKEN（刻意泄露）」。注册免码之后两者都不该再发生——
    // 一个没有消费端点的发码用途就是开放邮件中继，而它烧的是 Resend 日额度、赔的是发信域名。
    const before = (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    for (const email of ['newbie@example.com', 'MEMBER@Example.com']) {
      const res = await post('/api/auth/send-code').send({ email, purpose: 'register' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PURPOSE_INVALID');
    }
    expect(sent).toHaveLength(0);
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS c FROM auth_codes WHERE purpose = 'register'")
      .get() as { c: number };
    expect(rows.c).toBe(0);
    const after = (getDb().prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    expect(after).toBe(before); // 摘线不该顺手把建号口径也改掉
  });

  it('★ 摘线**不影响 `login` 通道**：已注册邮箱照样收到登录码', async () => {
    await seedUser('member@example.com');
    const res = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it(`★ ${AUTH_CODE_MAX_PER_IP_HOUR} 个未注册地址连着要登录码 ⇒ 全部 200（静默，但**都占 IP 名额**）`, async () => {
    // login 态对未注册走 `silent`：回一样的 200、一封不发、一行码不落库（用户枚举防线）。
    // ★★ 但**限流记账必须在注册与否之前**——只对"已注册"记账的话，「第 N+1 次收到 429」
    //    本身就成了一条枚举信号（未注册的永远不 429）。这条用例钉的就是这个顺序。
    //    （原用例借 `register` 用途演示同一件事；2026-09-22 摘线后改由 login 态承担，
    //      判据一字未变，变的只是用哪个用途。）
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) {
      const res = await post('/api/auth/send-code').send({ email: `ghost${i}@example.com`, purpose: 'login' });
      expect(res.status).toBe(200);
    }
    expect(sent).toHaveLength(0);
    const over = await post('/api/auth/send-code').send({ email: 'ghost-extra@example.com', purpose: 'login' });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('CODE_RATE_LIMITED');
    // ★★ 429 必须带 `retryAfterMs`（契约 §2.5）：被拒的那一刻用户**唯一**有用的信息是"还要等多久"。
    //   这条断言是 `_probe/auth-smoke.mjs` 真机跑到第 11 节才逼出来的——此前 `retryAfterMs`
    //   一路算到 `sendCode` 就被丢掉，而**所有单测都是绿的**（`code-limit.test.ts` 只断言限流器
    //   自己算得对，从没断言它到得了响应体）。移植时这条最容易被"顺手删掉"，故单独留注。
    expect(typeof over.body.retryAfterMs).toBe('number');
    expect(over.body.retryAfterMs).toBeGreaterThan(0);
    expect(over.body.retryAfterMs).toBeLessThanOrEqual(AUTH_CODE_WINDOW_MS);
  });

  it('★ 脏请求**不占限流名额**：未接线用途被拒之后，同 IP 的 login 码照发', async () => {
    // 校验闸在限流**之前**（`code-flow.ts#sendCode` 的顺序承诺）。反过来的话，
    // 一个脚本光刷 `register` 就能把整条出口 IP 的登录验证码全掐掉——
    // 而这正是免码之后最容易出现的场景（页面上还有人在发注册码）。
    await seedUser('member@example.com'); // 夹具直接落库 ⇒ 不占任何发码名额
    for (let i = 0; i < 8; i += 1) {
      const blocked = await post('/api/auth/send-code').send({ email: `stale${i}@example.com`, purpose: 'register' });
      expect(blocked.status).toBe(400);
    }
    const login = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    expect(login.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('连点 → 429 `CODE_RATE_LIMITED`，且**第二封不发**', async () => {
    await seedUser('member@example.com');
    await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    const again = await post('/api/auth/send-code').send({ email: 'member@example.com', purpose: 'login' });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('CODE_RATE_LIMITED');
    expect(sent).toHaveLength(1);
    // ★ 429 的响应体形状（契约 §2.5）：这条命中的是**最小间隔**那道闸 ⇒ 等待时长
    //   不可能超过它本身（比 60s 还长说明算错了闸门——比如把每小时窗口算进来）。
    expect(typeof again.body.retryAfterMs).toBe('number');
    expect(again.body.retryAfterMs).toBeGreaterThan(0);
    expect(again.body.retryAfterMs).toBeLessThanOrEqual(AUTH_CODE_RESEND_INTERVAL_MS);
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
