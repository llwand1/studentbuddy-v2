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
import {
  AUTH_CODE_MAX_PER_HOUR,
  AUTH_CODE_RESEND_INTERVAL_MS,
  AUTH_CODE_TTL_MS,
} from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-code-flow-test-'));
const { getDb } = await import('../storage/db.js');
const { createUser } = await import('./users.js');
const { decideSend, isPurposeWired, sendCode, loginByCode, registerAccount } = await import('./code-flow.js');
const { resetCodeLimits } = await import('./code-limit.js');
const { setMailSender } = await import('../mail/send.js');

/** 已注册账号（只建一次：scrypt 有成本，逐用例重建纯属浪费）。 */
const MEMBER = 'member@example.com';
await createUser(MEMBER, 'good-password-1', undefined);

const sent: Array<{ to: string; subject: string; text: string }> = [];

/** 抛错的域调用 → 取错误码（域层不碰 HTTP，失败就是 `Error(message=码)`）。 */
async function codeOf(fn: () => unknown): Promise<string> {
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

/**
 * ★ 每个用例要一个**没被注册过**的邮箱：`registerByCode` 会真建号，
 *   而本文件的 `beforeEach` 只清 `auth_codes`（`MEMBER` 是模块级建的，清表会连带 FK 麻烦）。
 *   ⇒ 用递增序号保证全局唯一，比"记得在用例里清 users"可靠。
 */
let seq = 0;
function freshEmail(): string {
  seq += 1;
  return `newbie${seq}@example.com`;
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

  it('★ 接线范围是**另一件事**：2026-09-22 起只剩 `login`（`register` 随 §2.7 作废摘线、`reset` 从未接线）', () => {
    // 与上面那张表分开测，是为了让策略表**每一格都能被验到**——
    // 混在一个函数里的话，`reset` 那一格会永远走不到，成为改错了没人报红的死分支。
    // ★ `register` 从 true 翻成 false 是本批最要紧的一格：翻回去就等于开了一个开放邮件中继。
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
    // ★ 2026-09-22 起 `register` 与 `reset` **同档未接线**（§2.7 作废 ⇒ 消费端点消失）
    expect(await codeOf(() => sendCode(MEMBER, 'register', '203.0.113.7'))).toBe('PURPOSE_INVALID');
    expect(await codeOf(() => sendCode(MEMBER, 'reset', '203.0.113.7'))).toBe('PURPOSE_INVALID');
    expect(sent).toHaveLength(0);
  });

  it('★ `register` 态在**接线闸**就被挡下：拿不到 `EMAIL_TAKEN`，也一封不发', async () => {
    // 作废前这条钉的是「已注册地址走 register 态 ⇒ 409 `EMAIL_TAKEN`（§2.5 表里唯一主动泄露
    // 「账号存在」的分支）」。现在它必须先挡在策略之前——**顺序本身就是那道邮件中继的闸**：
    // 若接线判定挪到限流/策略之后，未接线用途照样会把码发出去。
    // ★ 那张策略表仍在（`decideSend('register', true) === 'taken'`，本文件上面逐格钉着），
    //   因为**重开邮箱验证时它要原样接回去**；这里钉的是"今天接不回去"。
    expect(await codeOf(() => sendCode(MEMBER, 'register', '203.0.113.7'))).toBe('PURPOSE_INVALID');
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

/**
 * 2026-09-22（契约 §2.7「注册即验证」**作废**批）——注册免码之后，这一组钉的是三件事：
 *   ① `register` 用途的发码闸**必须已落下**（没有消费端点的发码用途＝开放邮件中继）；
 *   ② 纯校验顺序与 `EMAIL_TAKEN` 竞态兜底**原样保留**，只是不再核销码；
 *   ③ ★ 未验证邮箱**照旧建得出号**——把它写成用例是为了让本次拍板的代价**可见**，
 *      将来接 `reset`（找回密码）时谁要是把"收得到这封邮件"当身份凭据，这条就是现场证据。
 * ★ register/login 的 IP 分桶、邮箱桶跨用途共用，仍由 `code-limit.test.ts` 直调 `admitSend` 钉住
 *   （那一层与 HTTP 与接线范围都无关，摘用途不影响那两张表的正确性）。
 */
describe('auth/code-flow — 注册免码（§2.7 作废批）', () => {
  const IP = '198.51.100.9';

  it('★★ `register` 态发码一律 `PURPOSE_INVALID`：一封不发、一行码不落库', async () => {
    // 注册不再核销码 ⇒ 该用途没有消费端点。留着它等于"拿我们的通道给任意陌生邮箱发信"
    // （烧 Resend 日额度 + 发信域名被拉黑），而用户还会收到一封永远用不上的邮件。
    expect(await codeOf(() => sendCode(freshEmail(), 'register', IP))).toBe('PURPOSE_INVALID');
    expect(sent).toHaveLength(0);
    const rows = getDb().prepare('SELECT COUNT(*) AS c FROM auth_codes WHERE purpose = \'register\'').get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('建号闭环不再要码，昵称 trim 仍生效（与路由层同一份归一化）', async () => {
    const email = freshEmail();
    const user = await registerAccount(email, 'good-password-1', '  小明  ');
    expect(user.email).toBe(email);
    expect(user.nickname).toBe('小明');
  });

  it('★ 纯校验照旧各自回自己的码，且**失败一律不落库**', async () => {
    const email = freshEmail();
    expect(await codeOf(() => registerAccount(email, 'short', undefined))).toBe('PASSWORD_WEAK');
    expect(await codeOf(() => registerAccount(email, 'good-password-1', '一'.repeat(21)))).toBe('NICKNAME_INVALID');
    expect(await codeOf(() => registerAccount('not-an-email', 'good-password-1', undefined))).toBe('EMAIL_INVALID');
    const rows = getDb().prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get(email) as { c: number };
    expect(rows.c).toBe(0);
    expect((await registerAccount(email, 'good-password-1', undefined)).email).toBe(email);
  });

  it('★ 已注册邮箱 → `EMAIL_TAKEN`（库层 UNIQUE 兜底，不是 500）', async () => {
    // 免码之后这条路**不再是竞态专属**了：没有发码闸先拦一道，重复注册每次都直接撞库层约束。
    expect(await codeOf(() => registerAccount(MEMBER, 'good-password-1', undefined))).toBe('EMAIL_TAKEN');
  });

  it('⚠️ 拍板代价钉成用例：未经所有权证明的邮箱照旧建号', async () => {
    const squatted = 'someone-else@example-corp.com';
    expect((await registerAccount(squatted, 'good-password-1', undefined)).email).toBe(squatted);
    // 而真主人来注册时只会拿到"这个邮箱已经注册过了" —— 这就是那条代价的样子。
    expect(await codeOf(() => registerAccount(squatted, 'another-good-pw', undefined))).toBe('EMAIL_TAKEN');
  });

  it('★ 库里遗留的 `register` 码**不能**当 `login` 码用（两用途在库里就是两条记录）', async () => {
    // 生产库里可能还有作废前发出的 register 行，purpose 隔离必须继续挡得住它们。
    const { issueCode } = await import('./codes.js');
    const email = freshEmail();
    await registerAccount(email, 'good-password-1', undefined);
    const { code } = issueCode(email, 'register');
    expect(await codeOf(() => loginByCode(email, code))).toBe('CODE_INVALID');
  });
});
