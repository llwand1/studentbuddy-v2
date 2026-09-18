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
  AUTH_CODE_MAX_PER_IP_REGISTER_HOUR,
  AUTH_CODE_RESEND_INTERVAL_MS,
  AUTH_CODE_TTL_MS,
} from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-code-flow-test-'));
const { getDb } = await import('../storage/db.js');
const { createUser } = await import('./users.js');
const { decideSend, isPurposeWired, sendCode, loginByCode, registerByCode } = await import('./code-flow.js');
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

  it('★ 接线范围是**另一件事**：M1.6 起 `login` + `register`（`reset` 的消费端点还没落）', () => {
    // 与上面那张表分开测，是为了让策略表**每一格都能被验到**——
    // 混在一个函数里的话，`reset` 那一格会永远走不到，成为改错了没人报红的死分支
    expect(isPurposeWired('login')).toBe(true);
    expect(isPurposeWired('register')).toBe(true);
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
    // ★ `register` 已接线（M1.6）⇒ 不再在这一组；`reset` 仍未接线（密码找回端点未做）
    expect(await codeOf(() => sendCode(MEMBER, 'reset', '203.0.113.7'))).toBe('PURPOSE_INVALID');
    expect(sent).toHaveLength(0);
  });

  it('★ `register` 已接线：已注册地址 ⇒ `EMAIL_TAKEN`（**与 login 态刻意相反**：这里就是要泄露）', async () => {
    // 这是 §2.5 那张表里**唯一主动告诉对方「账号存在」**的分支。
    // 判据不是"一致就好"，而是「这个信息会不会让攻击者拿到他本来拿不到的东西」——
    // 「注册时已存在」不构成隐私：对方本来就能从 register 的 409 感知到，
    // 而注册流程里用户填错邮箱必须当场知道，否则他会一直等一封永远不来的信。
    expect(await codeOf(() => sendCode(MEMBER, 'register', '203.0.113.7'))).toBe('EMAIL_TAKEN');
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
 * M1.6（契约 §2.7「注册即验证」）——`register` 用途的 `sendCode` 与 `registerByCode`。
 *
 * ★ 这组用例守的核心是**顺序**：纯校验 → 核销码 → 建号。三步都不换，
 *   而"顺序对不对"恰恰是不会有任何运行时错误、只会**白烧用户一条码**的那类问题。
 */
describe('auth/code-flow — register 态 sendCode + registerByCode（M1.6 §2.7）', () => {
  const IP = '198.51.100.9';

  it('未注册 ⇒ 真发一封，且这个码**能建号**（注册流程的完整闭环）', async () => {
    const email = freshEmail();
    const r = await sendCode(email, 'register', IP);
    expect(r.expiresInMs).toBe(AUTH_CODE_TTL_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(email);

    const user = await registerByCode(email, codeFromLastMail(), 'good-password-1', '  小明  ');
    expect(user.email).toBe(email);
    expect(user.nickname).toBe('小明'); // 昵称 trim 生效（与路由层同一份归一化）
  });

  it('★ 码只能用一次：同一个码建完号再拿去建另一个号 → `CODE_INVALID`', async () => {
    const email = freshEmail();
    await sendCode(email, 'register', IP);
    const code = codeFromLastMail();
    await registerByCode(email, code, 'good-password-1', undefined);
    expect(await codeOf(() => registerByCode(freshEmail(), code, 'good-password-1', undefined))).toBe('CODE_INVALID');
  });

  it('★★ 纯校验失败**不烧码**：弱口令 / 坏昵称 / 坏邮箱被拒后，同一个码还能建号', async () => {
    // 顺序：纯校验 → 核销码 → 建号。反过来的话，「密码只打了 6 位」这种手滑
    // 会白烧一条码，用户得重新收信 —— 把可避免的失败挡在不可逆操作之前。
    const email = freshEmail();
    await sendCode(email, 'register', IP);
    const code = codeFromLastMail();

    expect(await codeOf(() => registerByCode(email, code, 'short', undefined))).toBe('PASSWORD_WEAK');
    expect(await codeOf(() => registerByCode(email, code, 'good-password-1', '一'.repeat(21)))).toBe('NICKNAME_INVALID');
    expect(await codeOf(() => registerByCode('not-an-email', code, 'good-password-1', undefined))).toBe('EMAIL_INVALID');

    const user = await registerByCode(email, code, 'good-password-1', undefined); // ★ 码还活着
    expect(user.email).toBe(email);
  });

  it('★ 码错 → `CODE_INVALID`；码过期 → `CODE_EXPIRED`（与 login 态同一套语义）', async () => {
    const email = freshEmail();
    const now = 1_000;
    await sendCode(email, 'register', IP, now);
    expect(await codeOf(() => registerByCode(email, '000000', 'good-password-1', undefined, now + 1))).toBe('CODE_INVALID');
    expect(await codeOf(() => registerByCode(email, codeFromLastMail(), 'good-password-1', undefined, now + AUTH_CODE_TTL_MS)))
      .toBe('CODE_EXPIRED');
  });

  it('★ `register` 码**不能**当 `login` 码用（两个用途在库里就是两条记录）', async () => {
    const email = freshEmail();
    await sendCode(email, 'register', IP);
    const code = codeFromLastMail();
    expect(await codeOf(async () => loginByCode(email, code))).toBe('CODE_INVALID');
  });

  it('★ 已注册邮箱走**竞态兜底**：直插一条 register 码 → `EMAIL_TAKEN`（不是 500）', async () => {
    // 正常流程里 `sendCode('register')` 已先抛 EMAIL_TAKEN，走不到这里；
    // 但并发下两个请求可能都拿到码 ⇒ 第二个人建号时撞到库层 `users.email UNIQUE`。
    // 撞了必须翻译成 409，原样漏出去就是 500（看着像我们挂了，其实是可预期的业务冲突）。
    const { issueCode } = await import('./codes.js');
    const { code } = issueCode(MEMBER, 'register');
    expect(await codeOf(() => registerByCode(MEMBER, code, 'good-password-1', undefined))).toBe('EMAIL_TAKEN');
  });

  it('★★ register 的 IP 桶更严（5/小时）且**与 login 分桶**', async () => {
    // 两个用途共用一个 IP 桶的话，「有人拿 register 刷满」会连带掐死同一出口 IP 上
    // 所有人的验证码登录 —— 校园网 / 公司网 / 运营商 NAT 全中招。这是分桶的全部理由。
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_REGISTER_HOUR; i += 1) {
      await sendCode(freshEmail(), 'register', IP, 1_000 + i * AUTH_CODE_RESEND_INTERVAL_MS);
    }
    const blocked = await codeOf(() =>
      sendCode(freshEmail(), 'register', IP, 1_000 + AUTH_CODE_MAX_PER_IP_REGISTER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS),
    );
    expect(blocked).toBe('CODE_RATE_LIMITED');

    // ★ 同一个 IP 上，已注册用户的 login 码照样发得出去
    await expect(sendCode(MEMBER, 'login', IP, 1_000)).resolves.toEqual({ expiresInMs: AUTH_CODE_TTL_MS });
  });

  it('★ 邮箱桶**跨用途共用**：register 刷满后同一邮箱的 login 也发不出（防"换个用途绕过"）', async () => {
    const email = freshEmail();
    for (let i = 0; i < AUTH_CODE_MAX_PER_HOUR; i += 1) {
      await sendCode(email, 'register', `10.0.0.${i}`, 1_000 + i * AUTH_CODE_RESEND_INTERVAL_MS);
    }
    // 换 IP 也没用：邮箱维度是跨用途共用的
    const err = await codeOf(() => sendCode(email, 'login', '10.0.0.99', 1_000 + AUTH_CODE_MAX_PER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS));
    expect(err).toBe('CODE_RATE_LIMITED');
  });
});
