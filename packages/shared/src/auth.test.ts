import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  passwordProblem,
  normalizeAuthNickname,
  nicknameFromEmail,
  AUTH_EMAIL_MAX,
  AUTH_PASSWORD_MIN,
  AUTH_PASSWORD_MAX,
  AUTH_NICKNAME_MAX,
} from './auth.js';

describe('shared/auth — 邮箱归一化（前后端共用一份，不许各写一套）', () => {
  it('去空白 + 转小写（防止 A@x.com 与 a@x.com 建出两个账号）', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('非法输入一律回 null（不猜、不纠正）', () => {
    for (const bad of ['', '   ', 'no-at-sign', 'a@b', 'a@b.', '@b.com', 'a@.com', 42, null, undefined, {}]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it('超长邮箱回 null（边界：正好 AUTH_EMAIL_MAX 通过）', () => {
    const local = 'a'.repeat(AUTH_EMAIL_MAX - '@example.com'.length);
    const okEmail = `${local}@example.com`;
    expect(okEmail.length).toBe(AUTH_EMAIL_MAX);
    expect(normalizeEmail(okEmail)).toBe(okEmail);
    expect(normalizeEmail(`x${okEmail}`)).toBeNull();
  });
});

describe('shared/auth — 密码合规（只判长度，不搞复杂度硬规则）', () => {
  it('长度达标 → null（通过）', () => {
    expect(passwordProblem('a'.repeat(AUTH_PASSWORD_MIN))).toBeNull();
    expect(passwordProblem('a'.repeat(AUTH_PASSWORD_MAX))).toBeNull();
  });

  it('过短 / 过长 / 非字符串 → PASSWORD_WEAK', () => {
    expect(passwordProblem('a'.repeat(AUTH_PASSWORD_MIN - 1))).toBe('PASSWORD_WEAK');
    expect(passwordProblem('a'.repeat(AUTH_PASSWORD_MAX + 1))).toBe('PASSWORD_WEAK');
    expect(passwordProblem(12345678)).toBe('PASSWORD_WEAK');
    expect(passwordProblem(undefined)).toBe('PASSWORD_WEAK');
  });
});

describe('shared/auth — 昵称（可空字段：不传即合法）', () => {
  it('不传 / 空串 → 归一为空串（由调用方回落到派生昵称）', () => {
    expect(normalizeAuthNickname(undefined)).toBe('');
    expect(normalizeAuthNickname(null)).toBe('');
    expect(normalizeAuthNickname('')).toBe('');
  });

  it('传了必须 trim 后 1~上限；超长回 null（非法）', () => {
    expect(normalizeAuthNickname('  小明  ')).toBe('小明');
    expect(normalizeAuthNickname('a'.repeat(AUTH_NICKNAME_MAX))).toBe('a'.repeat(AUTH_NICKNAME_MAX));
    expect(normalizeAuthNickname('a'.repeat(AUTH_NICKNAME_MAX + 1))).toBeNull();
    expect(normalizeAuthNickname('   ')).toBeNull();
    expect(normalizeAuthNickname(7)).toBeNull();
  });
});

describe('shared/auth — 默认昵称派生', () => {
  it('取 @ 前那段；空本地部分回落「学习者」', () => {
    expect(nicknameFromEmail('alice@example.com')).toBe('alice');
    expect(nicknameFromEmail('@example.com')).toBe('学习者');
  });

  it('超长本地部分按昵称上限截断', () => {
    const long = `${'b'.repeat(40)}@x.com`;
    expect(nicknameFromEmail(long)).toHaveLength(AUTH_NICKNAME_MAX);
  });
});
