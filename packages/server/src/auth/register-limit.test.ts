/**
 * auth/register-limit 测试（**纯内存、零 IO**，不建库）：注册端点的那道按 IP 计数。
 *
 * ★ 本文件钉的是「摘掉邮箱验证码之后，注册还剩下什么闸」——它挡的是一个**静默的成本事故**：
 *   无限建号 ⇒ 每号一份平台配额（250 次/5h，走平台 key）⇒ 真人收到「繁忙」，
 *   而我方额度已空。写错这里不会有任何运行时错误，只会让闸失效，故逐条钉死。
 * ★ 与 `code-limit.test.ts` 同样的口径：**准入，不是记账** ⇒ 被拒的请求不得延长封锁。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AUTH_CODE_WINDOW_MS, AUTH_REGISTER_MAX_PER_IP_HOUR } from '@sb/shared';
import { admitRegister, resetRegisterLimits } from './register-limit.js';

const IP = '203.0.113.7';
const T0 = 1_000_000;

/** 连续申请 n 次，返回每次的 ok（用于断言"前 5 过、第 6 拒"这种梯度）。 */
function sweep(ip: string, n: number, now: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i += 1) out.push(admitRegister(ip, now).ok);
  return out;
}

beforeEach(() => {
  resetRegisterLimits();
});

describe('auth/register-limit — 按 IP 的注册额度', () => {
  it(`前 ${AUTH_REGISTER_MAX_PER_IP_HOUR} 次放行，第 ${AUTH_REGISTER_MAX_PER_IP_HOUR + 1} 次拒`, () => {
    const results = sweep(IP, AUTH_REGISTER_MAX_PER_IP_HOUR + 1, T0);
    expect(results.slice(0, AUTH_REGISTER_MAX_PER_IP_HOUR)).toEqual(
      Array(AUTH_REGISTER_MAX_PER_IP_HOUR).fill(true),
    );
    expect(results.at(-1)).toBe(false);
  });

  it('★ 被拒的请求**不延长**封锁：一直撞闸也只在满 1 小时后放行', () => {
    sweep(IP, AUTH_REGISTER_MAX_PER_IP_HOUR, T0);
    // 撞闸十次（每次都不该记账）
    for (let i = 1; i <= 10; i += 1) expect(admitRegister(IP, T0 + i * 60_000).ok).toBe(false);
    expect(admitRegister(IP, T0 + AUTH_CODE_WINDOW_MS - 1).ok).toBe(false);
    expect(admitRegister(IP, T0 + AUTH_CODE_WINDOW_MS).ok).toBe(true);
  });

  it('`retryAfterMs` 是"还要等多久"，不是窗口长度（越晚问、数越小）', () => {
    sweep(IP, AUTH_REGISTER_MAX_PER_IP_HOUR, T0);
    const first = admitRegister(IP, T0 + 1);
    const later = admitRegister(IP, T0 + 60_000);
    expect(first.ok).toBe(false);
    expect(later.ok).toBe(false);
    if (!first.ok && !later.ok) {
      expect(first.retryAfterMs).toBe(AUTH_CODE_WINDOW_MS - 1);
      expect(later.retryAfterMs).toBe(AUTH_CODE_WINDOW_MS - 60_000);
    }
  });

  it('换 IP 即换桶：共享出口只影响该出口自己，不牵连别的地址', () => {
    sweep(IP, AUTH_REGISTER_MAX_PER_IP_HOUR, T0);
    expect(admitRegister('203.0.113.8', T0).ok).toBe(true);
  });

  it('⚠️ 空 IP 也计数（落在同一个键上）——拿不到 IP 恰恰是最该限流的场景', () => {
    sweep('', AUTH_REGISTER_MAX_PER_IP_HOUR, T0);
    expect(admitRegister('', T0).ok).toBe(false);
  });
});
