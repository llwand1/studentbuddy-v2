import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  passwordProblem,
  normalizeAuthNickname,
  nicknameFromEmail,
  normalizeCode,
  normalizePurpose,
  formatCode,
  AUTH_CODE_LEN,
  AUTH_CODE_MAX_ATTEMPTS,
  AUTH_CODE_MAX_PER_HOUR,
  AUTH_CODE_MAX_PER_IP_HOUR,
  AUTH_CODE_PURPOSES,
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

describe('shared/auth — 验证码纯校验（M1.5，前后端共用一份）', () => {
  it('恰好 6 位数字通过；首尾空白被 trim（用户从邮件复制常带空格）', () => {
    expect(normalizeCode('123456')).toBe('123456');
    expect(normalizeCode('  000007 \n')).toBe('000007');
  });

  it('位数不对 / 含非数字 / 非字符串 → null（**不做「去掉中间空格连字符」的猜测**）', () => {
    for (const bad of ['12345', '1234567', '', '   ', '12345a', '12 456', '12-456', 123456, null, undefined, {}]) {
      expect(normalizeCode(bad)).toBeNull();
    }
  });

  it('formatCode 补零到固定位数（不补的话 `7` 与用户的 `000007` 对不上，且长度校验会拒掉）', () => {
    expect(formatCode(7)).toBe('000007');
    expect(formatCode(0)).toBe('000000');
    expect(formatCode(999999)).toBe('999999');
    expect(formatCode(999999)).toHaveLength(AUTH_CODE_LEN);
  });

  it('normalizePurpose 只认三个已知用途，**不给缺省值**', () => {
    for (const p of AUTH_CODE_PURPOSES) expect(normalizePurpose(p)).toBe(p);
    expect(normalizePurpose(' login ')).toBe('login');
    // ★ 缺省 / 未知一律 null（不默认成 login）：默认成 login 会把「忘传 purpose」
    //   静默当成登录请求，而它本该是 400——默认值要落在能被发现的那一侧
    for (const bad of [undefined, null, '', 'LOGIN', 'signup', 'login2', 42, {}]) {
      expect(normalizePurpose(bad)).toBeNull();
    }
  });
});

describe('shared/auth — 验证码常量不变式（改错了不会有别的测试报红）', () => {
  it('尝试上限必须存在且为正整数——它是 6 位码的**唯一**防线（10^6 空间对脚本是分钟级）', () => {
    expect(Number.isInteger(AUTH_CODE_MAX_ATTEMPTS)).toBe(true);
    expect(AUTH_CODE_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    // 上限一旦大于等于空间本身，这条防线就等于不存在
    expect(AUTH_CODE_MAX_ATTEMPTS).toBeLessThan(10 ** AUTH_CODE_LEN);
  });

  it('三道限流的关系：同邮箱上限必须严于同 IP 上限（否则「防定向刷」这道闸形同虚设）', () => {
    expect(AUTH_CODE_MAX_PER_HOUR).toBeGreaterThan(0);
    expect(AUTH_CODE_MAX_PER_IP_HOUR).toBeGreaterThan(AUTH_CODE_MAX_PER_HOUR);
  });
});
