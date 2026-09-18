/**
 * auth/code-flow 测试（隔离库）：**§2.5 那张策略表 + 限流顺序 + 发信失败处置**。
 *
 * ★ 本文件守的是"静默漏洞"类的东西——改错了不会有任何运行时错误，只会少一道防线：
 *   ① `decideSend` 全表逐格钉死（尤其 `login` 态**注册与否响应必须逐字相同**）；
 *   ② **限流记账在注册与否之前**（只对已注册记账 ⇒ 429 本身成了一条枚举信号）；
 *   ③ `login` 态未注册时**一行码都不落库**（落了库就等于给不存在的账号发了信）。
 *
 * ★ 发信一律用**桩**（`setMailSender`），绝不真发：会烧 Resend 额度、还会给真人发邮件。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_CODE_MAX_PER_HOUR, AUTH_CODE_RESEND_INTERVAL_MS, AUTH_CODE_TTL_MS } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-code-flow-test-'));
const { getDb } = await import('../storage/db.js');
const { createUser } = await import('./users.js');
const { decideSend, isPurposeWired, sendCode, loginByCode } = await import('./code-flow.js');
const { resetCodeLimits } = await import('./code-limit.js');
const { setMailSender } = await import('../mail/send.js');

/** 已注册账号（只建一次：scrypt 有成本，逐用例重建纯属浪费）。 */
const MEMBER = 'member@example.com';
await createUser(MEMBER, 'good-password-1', undefined);

const sent: Array<{ to: string; subject: string; text: string }> = [];

/** 抛错的域调用 → 取错误码（域层不碰 HTTP，失败就是 `Error(message=码)`）。 */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('预期抛错，实际成功');
}

/** 从邮件正文首行取验证码（`buildCodeMail` 把它单独成行，就是为了这一眼能抄到）。 */
function codeFromLastMail(): string {
  const last = sent[sent.length - 1];
  if (!last) throw new Error('预期有发信，实际一封都没发');
  return last.text.split('\n')[0] ?? '';
}

beforeEach(() => {
  getDb().prepare('DELETE FROM auth_codes').run();
  resetCodeLimits();
  sent.length = 0;
  setMailSender({
    name: 'test',
    send: (msg) => {
      sent.push(msg);
      return Promise.resolve();
    },
  });
});

describe('auth/code-flow — decideSend：契约 §2.5 那张表逐格钉死', () => {
  it('`login`：**注册与否都回同一个响应**（一个发信、一个静默，但调用方看不出区别）', () => {
    expect(decideSend('login', true)).toBe('send');
    expect(decideSend('login', false)).toBe('silent');
  });

  it('`register`：已注册**刻意回 409**（用户填错邮箱要当场知道）、未注册才发信', () => {
    expect(decideSend('register', true)).toBe('taken');
    expect(decideSend('register', false)).toBe('send');
  });

  it('`reset`：与 login 同口径（找回密码同样不该泄露账号是否存在）', () => {
    expect(decideSend('reset', true)).toBe('send');
    expect(decideSend('reset', false)).toBe('silent');
  });

  it('★ 接线范围是**另一件事**：本批只有 `login`（`register`/`reset` 的消费端点还没落）', () => {
    // 与上面那张表分开测，是为了让策略表**每一格都能被验到**——
    // 混在一个函数里的话，`register`/`reset` 两格会永远走不到，成为改错了没人报红的死分支
    expect(isPurposeWired('login')).toBe(true);
    expect(isPurposeWired('register')).toBe(false);
    expect(isPurposeWired('reset')).toBe(false);
  });
});

describe('auth/code-flow — sendCode（login 态）', () => {
  it('已注册 ⇒ 真发一封，正文首行就是 6 位码，且**这个码能登录**', async () => {
    const r = await sendCode(MEMBER, 'login', '203.0.113.7');
    expect(r.expiresInMs).toBe(AUTH_CODE_TTL_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(MEMBER);

    const user = loginByCode(MEMBER, codeFromLastMail());
    expect(user.email).toBe(MEMBER);
  });

  it('未注册 ⇒ 响应与已注册**逐字相同**，但**一封不发、一行码不落库**', async () => {
    const ghost = 'nobody@example.com';
    const registered = await sendCode(MEMBER, 'login', '203.0.113.7');
    const notRegistered = await sendCode(ghost, 'login', '203.0.113.8');
    expect(notRegistered).toEqual(registered); // ★ 响应体逐字相同（枚举防线）

    expect(sent).toHaveLength(1); // 只给已注册那封发了
    expect(sent[0]?.to).toBe(MEMBER);
    expect((getDb().prepare(`SELECT COUNT(*) AS c FROM auth_codes WHERE email = ?`).get(ghost) as { c: number }).c).toBe(0);
  });

  it('★ 未注册也**照样消耗限流额度**（只对已注册记账 ⇒ 第 6 次的 429 就成了枚举信号）', async () => {
    const ghost = 'nobody@example.com';
    for (let i = 0; i < AUTH_CODE_MAX_PER_HOUR; i += 1) {
      await sendCode(ghost, 'login', '203.0.113.7', 1_000 + i * AUTH_CODE_RESEND_INTERVAL_MS);
    }
    const err = await codeOf(() => sendCode(ghost, 'login', '203.0.113.7', 1_000 + AUTH_CODE_MAX_PER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS));
    expect(err).toBe('CODE_RATE_LIMITED');
    expect(sent).toHaveLength(0); // 全程一封没发，但额度确实被消耗了
  });

  it('限流在最前：连点第二次即 429 `CODE_RATE_LIMITED`，且**第二封不发**', async () => {
    await sendCode(MEMBER, 'login', '203.0.113.7', 1_000);
    const err = await codeOf(() => sendCode(MEMBER, 'login', '203.0.113.7', 1_001));
    expect(err).toBe('CODE_RATE_LIMITED');
    expect(sent).toHaveLength(1);
  });

  it('发信失败 ⇒ `MAIL_SEND_FAILED`（**不让用户干等**），且错误里不带验证码', async () => {
    setMailSender({ name: 'boom', send: () => Promise.reject(new Error('resend http 500')) });
    const err = await codeOf(() => sendCode(MEMBER, 'login', '203.0.113.7'));
    expect(err).toBe('MAIL_SEND_FAILED');
  });
});

describe('auth/code-flow — 入参校验与未接线用途', () => {
  it('邮箱非法 → EMAIL_INVALID；用途非法 / 未接线 → PURPOSE_INVALID', async () => {
    expect(await codeOf(() => sendCode('not-an-email', 'login', '203.0.113.7'))).toBe('EMAIL_INVALID');
    expect(await codeOf(() => sendCode(MEMBER, 'signup', '203.0.113.7'))).toBe('PURPOSE_INVALID');
    expect(await codeOf(() => sendCode(MEMBER, undefined, '203.0.113.7'))).toBe('PURPOSE_INVALID');
    expect(await codeOf(() => sendCode(MEMBER, 'register', '203.0.113.7'))).toBe('PURPOSE_INVALID');
    expect(await codeOf(() => sendCode(MEMBER, 'reset', '203.0.113.7'))).toBe('PURPOSE_INVALID');
    expect(sent).toHaveLength(0);
  });

  it('入参非法**不消耗限流额度**（校验闸在限流之前，脏请求不该占用户的名额）', async () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_HOUR * 3; i += 1) {
      await codeOf(() => sendCode('not-an-email', 'login', '203.0.113.7'));
    }
    expect((await sendCode(MEMBER, 'login', '203.0.113.7')).expiresInMs).toBe(AUTH_CODE_TTL_MS);
  });
});

describe('auth/code-flow — loginByCode', () => {
  it('码正确 ⇒ 返回该账号；**码只能用一次**', async () => {
    await sendCode(MEMBER, 'login', '203.0.113.7');
    const code = codeFromLastMail();
    expect(loginByCode(MEMBER, code).email).toBe(MEMBER);
    expect(await codeOf(async () => loginByCode(MEMBER, code))).toBe('CODE_INVALID');
  });

  it('码错 → CODE_INVALID；过期 → CODE_EXPIRED', async () => {
    const now = 1_000;
    await sendCode(MEMBER, 'login', '203.0.113.7', now);
    expect(await codeOf(async () => loginByCode(MEMBER, '000000', now + 1))).toBe('CODE_INVALID');
    expect(await codeOf(async () => loginByCode(MEMBER, codeFromLastMail(), now + AUTH_CODE_TTL_MS))).toBe('CODE_EXPIRED');
  });

  it('邮箱非法 → EMAIL_INVALID；邮箱大小写/空白不影响（走同一份归一化）', async () => {
    expect(await codeOf(async () => loginByCode('nope', '123456'))).toBe('EMAIL_INVALID');
    await sendCode(MEMBER, 'login', '203.0.113.7');
    expect(loginByCode(`  ${MEMBER.toUpperCase()}  `, codeFromLastMail()).email).toBe(MEMBER);
  });

  it('★ 未注册邮箱 → CREDENTIALS_INVALID（与密码登录同一个码），**不自动建号**', async () => {
    // 先造一条"已发码但账号不存在"的状态（只能绕过 sendCode 的静默策略：直插一行码）
    const { issueCode } = await import('./codes.js');
    const ghost = 'ghost@example.com';
    const { code } = issueCode(ghost, 'login', Date.now());
    expect(await codeOf(async () => loginByCode(ghost, code))).toBe('CREDENTIALS_INVALID');
    expect((getDb().prepare(`SELECT COUNT(*) AS c FROM users WHERE email = ?`).get(ghost) as { c: number }).c).toBe(0);
  });
});
