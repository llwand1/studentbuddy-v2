/**
 * auth/codes 测试（隔离库）：签发 / 作废旧码 / 一次性 / 尝试上限 / 用途隔离 / 过期。
 *
 * ★ 最要紧的两条断言：
 *   ① 「**库内只存哈希、不存明文码**」——它是"拖库拿不到可用码"这个承诺的唯一可验证形式；
 *      ⚠️ 同时必须清醒：6 位码只有 10^6 空间，**哈希对在线爆破零作用**，
 *      真正的防线是下面 ③ 的尝试上限（本文件把两者分开测，免得读的人以为哈希在挡爆破）。
 *   ② 「**尝试次数耗尽后，正确的码也用不了**」——这是 6 位码的唯一防线。
 *      若哪天有人把上限判断挪到比对之后、或删掉，10^6 空间对脚本就是分钟级的事。
 *
 * ★ 时间一律注入（`now` 参数），**不 mock 系统时钟**：本模块所有时间判断都收 `now` 入参，
 *   注入比 mock 更直接，也不会污染其它用例。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_CODE_MAX_ATTEMPTS, AUTH_CODE_TTL_MS } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-auth-codes-test-'));
const { getDb } = await import('../storage/db.js');
const { issueCode, consumeCode, hashCode, claimCode, purgeExpiredCodes, genCode } = await import('./codes.js');

const EMAIL = 'coder@example.com';

/** 直接读该邮箱最新的码行（断言库内形态用）。 */
function latestRow(email = EMAIL): { id: number; code_hash: string; attempts: number; consumed_at: number | null; purpose: string } {
  const row = getDb()
    .prepare(`SELECT id, code_hash, attempts, consumed_at, purpose FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1`)
    .get(email) as { id: number; code_hash: string; attempts: number; consumed_at: number | null; purpose: string } | undefined;
  if (!row) throw new Error(`预期有码行，实际没有（email=${email}）`);
  return row;
}

/** 抛错的域调用 → 取它的错误码（域层不碰 HTTP，失败就是 `Error(message=码)`）。 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('预期抛错，实际成功');
}

beforeEach(() => {
  getDb().prepare('DELETE FROM auth_codes').run();
});

describe('auth/codes — 签发与库内形态', () => {
  it('返回明文码；**库里只有 SHA-256，且不等于明文**', () => {
    const { code, expiresInMs } = issueCode(EMAIL, 'login', 1_000);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresInMs).toBe(AUTH_CODE_TTL_MS);

    const row = latestRow();
    expect(row.code_hash).toBe(hashCode(code));
    expect(row.code_hash).not.toBe(code); // 明文码不落库
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('过期时刻 = now + TTL（注入时间可直接断言，不必等真时钟）', () => {
    issueCode(EMAIL, 'login', 5_000);
    const row = getDb().prepare(`SELECT expires_at FROM auth_codes WHERE email = ?`).get(EMAIL) as { expires_at: number };
    expect(row.expires_at).toBe(5_000 + AUTH_CODE_TTL_MS);
  });

  it('genCode 恒为 6 位数字且会补零（`7` 必须变成 `000007`）', () => {
    for (let i = 0; i < 50; i += 1) expect(genCode()).toMatch(/^\d{6}$/);
  });

  it('邮箱非法 / 用途非法 → EMAIL_INVALID / PURPOSE_INVALID，且**一行都不落库**', () => {
    expect(codeOf(() => issueCode('not-an-email', 'login'))).toBe('EMAIL_INVALID');
    expect(codeOf(() => issueCode(EMAIL, 'signup'))).toBe('PURPOSE_INVALID');
    expect(codeOf(() => issueCode(EMAIL, undefined))).toBe('PURPOSE_INVALID');
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM auth_codes').get() as { c: number }).c).toBe(0);
  });
});

describe('auth/codes — 一次性与旧码作废', () => {
  it('校验成功即消费：**重放同一个码必失败**', () => {
    const { code } = issueCode(EMAIL, 'login', 1_000);
    expect(consumeCode(EMAIL, 'login', code, 1_100)).toEqual({ email: EMAIL, purpose: 'login' });
    expect(codeOf(() => consumeCode(EMAIL, 'login', code, 1_200))).toBe('CODE_INVALID');
  });

  it('发新码作废同用途旧码：**旧码失效、新码可用**，且旧行仍在库里（作废是标记不是删除）', () => {
    const first = issueCode(EMAIL, 'login', 1_000).code;
    const second = issueCode(EMAIL, 'login', 2_000).code;
    expect(second).not.toBe(first);

    expect(codeOf(() => consumeCode(EMAIL, 'login', first, 2_100))).toBe('CODE_INVALID');
    expect(consumeCode(EMAIL, 'login', second, 2_100).purpose).toBe('login');

    // 两行都在：旧行被标记作废（consumed_at 非空），保留下来供审计
    const rows = getDb().prepare(`SELECT consumed_at FROM auth_codes WHERE email = ? ORDER BY id`).all(EMAIL) as Array<{
      consumed_at: number | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.consumed_at).toBe(2_000);
  });

  it('作废**只作用于同用途**：login 发新码不会把 reset 的待用码作废', () => {
    const resetCode = issueCode(EMAIL, 'reset', 1_000).code;
    issueCode(EMAIL, 'login', 2_000);
    expect(consumeCode(EMAIL, 'reset', resetCode, 2_100).purpose).toBe('reset');
  });

  it('原子认领：同一行认领两次，第二次必 false（这就是"双花"被挡住的机制）', () => {
    issueCode(EMAIL, 'login', 1_000);
    const id = latestRow().id;
    expect(claimCode(id, 1_100)).toBe(true);
    expect(claimCode(id, 1_200)).toBe(false);
  });
});

describe('auth/codes — 尝试次数上限（6 位码的唯一防线）', () => {
  it(`错 ${AUTH_CODE_MAX_ATTEMPTS} 次后**正确的码也用不了**（不靠过期兜底）`, () => {
    const { code } = issueCode(EMAIL, 'login', 1_000);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < AUTH_CODE_MAX_ATTEMPTS; i += 1) {
      expect(codeOf(() => consumeCode(EMAIL, 'login', wrong, 1_100 + i))).toBe('CODE_INVALID');
    }
    expect(latestRow().attempts).toBe(AUTH_CODE_MAX_ATTEMPTS);
    // ★ 本条是整组用例的落点：码还没过期、内容也正确，但已作废
    expect(codeOf(() => consumeCode(EMAIL, 'login', code, 2_000))).toBe('CODE_INVALID');
  });

  it('上限内猜对仍能通过（上限不能定得过紧把正常用户挡在门外）', () => {
    const { code } = issueCode(EMAIL, 'login', 1_000);
    const wrong = code === '000000' ? '111111' : '000000';
    expect(codeOf(() => consumeCode(EMAIL, 'login', wrong, 1_100))).toBe('CODE_INVALID');
    expect(codeOf(() => consumeCode(EMAIL, 'login', wrong, 1_200))).toBe('CODE_INVALID');
    expect(consumeCode(EMAIL, 'login', code, 1_300).email).toBe(EMAIL);
  });

  it('格式不对**不消耗尝试次数**（手滑多打一位不该把用户的码打废）', () => {
    const { code } = issueCode(EMAIL, 'login', 1_000);
    for (const bad of ['12345', 'abcdef', '12 456', '']) {
      expect(codeOf(() => consumeCode(EMAIL, 'login', bad, 1_100))).toBe('CODE_INVALID');
    }
    expect(latestRow().attempts).toBe(0);
    expect(consumeCode(EMAIL, 'login', code, 1_200).email).toBe(EMAIL);
  });
});

describe('auth/codes — 过期与不存在', () => {
  it('过期 → CODE_EXPIRED（与 CODE_INVALID 分开：用户动作不同，重发 vs 重输）', () => {
    const { code } = issueCode(EMAIL, 'login', 1_000);
    expect(codeOf(() => consumeCode(EMAIL, 'login', code, 1_000 + AUTH_CODE_TTL_MS))).toBe('CODE_EXPIRED');
  });

  it('没发过码 → CODE_INVALID（**不区分**"没发过/已用过/被作废"三种，避免成为状态探针）', () => {
    expect(codeOf(() => consumeCode('nobody@example.com', 'login', '123456', 1_000))).toBe('CODE_INVALID');
  });

  it('用途隔离：login 的码拿去 reset 校验必失败（登录的码不能换来改密码的权）', () => {
    const { code } = issueCode(EMAIL, 'login', 1_000);
    expect(codeOf(() => consumeCode(EMAIL, 'reset', code, 1_100))).toBe('CODE_INVALID');
  });

  it('purgeExpiredCodes 只删「过期且未消费」的，**已消费的行留着**（审计不是垃圾）', () => {
    const used = issueCode('used@example.com', 'login', 1_000).code;
    consumeCode('used@example.com', 'login', used, 1_100);
    issueCode('stale@example.com', 'login', 1_000); // 会过期、未消费

    const removed = purgeExpiredCodes(1_000 + AUTH_CODE_TTL_MS + 1);
    expect(removed).toBe(1);
    expect((getDb().prepare(`SELECT COUNT(*) AS c FROM auth_codes WHERE email = 'used@example.com'`).get() as { c: number }).c).toBe(1);
    expect((getDb().prepare(`SELECT COUNT(*) AS c FROM auth_codes WHERE email = 'stale@example.com'`).get() as { c: number }).c).toBe(0);
  });
});
