/**
 * auth/code-limit 测试：**纯内存、零 IO 零 DB**（契约 docs/AUTH-SPEC.md §4.5）。
 *
 * 三道闸门全在这一层钉死，理由与 `shared/ebbinghaus.test.ts` 同：限流的正确性**只有边界**，
 * 而边界跑在真端点里既慢又要造一堆用户。时间一律注入 `now`。
 *
 * ★ 本文件守着一个容易被"优化"掉的语义：**被拒的请求不记账**。
 *   若改成"先记账再判"，被刷时窗口会不断后移，正常用户**一小时内永远等不到窗口滑出**
 *   （越刷越封），而这类退化不会让任何别的测试报红。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AUTH_CODE_MAX_PER_HOUR,
  AUTH_CODE_MAX_PER_IP_HOUR,
  AUTH_CODE_RESEND_INTERVAL_MS,
  AUTH_CODE_WINDOW_MS,
} from '@sb/shared';
import { admitSend, resetCodeLimits } from './code-limit.js';

const EMAIL = 'a@example.com';
const IP = '203.0.113.7';

/** 便于读的常量：窗口起点。 */
const T0 = 1_000_000;

beforeEach(() => {
  resetCodeLimits();
});

describe('auth/code-limit — 闸门一：同邮箱最小间隔', () => {
  it('首次放行；间隔内再发被拒，且 `retryAfterMs` 正好指到解禁时刻', () => {
    expect(admitSend(EMAIL, IP, T0)).toEqual({ ok: true });
    const blocked = admitSend(EMAIL, IP, T0 + 1);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('预期被拒');
    expect(blocked.retryAfterMs).toBe(AUTH_CODE_RESEND_INTERVAL_MS - 1);
  });

  it('间隔一到即放行（边界：正好等于间隔通过）', () => {
    admitSend(EMAIL, IP, T0);
    expect(admitSend(EMAIL, IP, T0 + AUTH_CODE_RESEND_INTERVAL_MS)).toEqual({ ok: true });
  });

  it('**被拒的请求不记账**：连刷 100 次不会把窗口一路后移', () => {
    admitSend(EMAIL, IP, T0);
    for (let i = 1; i <= 100; i += 1) admitSend(EMAIL, IP, T0 + i);
    // 若"先记账再判"，第 2 次起每次都会刷新最近时刻 ⇒ 这里必然被拒
    expect(admitSend(EMAIL, IP, T0 + AUTH_CODE_RESEND_INTERVAL_MS)).toEqual({ ok: true });
  });

  it('不同邮箱互不影响（闸门按邮箱分桶）', () => {
    admitSend(EMAIL, IP, T0);
    expect(admitSend('b@example.com', IP, T0 + 1)).toEqual({ ok: true });
  });
});

describe('auth/code-limit — 闸门二：同邮箱每小时封数', () => {
  /** 间隔地发满 `AUTH_CODE_MAX_PER_HOUR` 封。 */
  function sendHourly(email: string, ip: string): void {
    for (let i = 0; i < AUTH_CODE_MAX_PER_HOUR; i += 1) {
      const r = admitSend(email, ip, T0 + i * AUTH_CODE_RESEND_INTERVAL_MS);
      expect(r).toEqual({ ok: true });
    }
  }

  it(`第 ${AUTH_CODE_MAX_PER_HOUR} 封之后被拒（间隔都够，是**封数**这道闸拦下的）`, () => {
    sendHourly(EMAIL, IP);
    const blocked = admitSend(EMAIL, IP, T0 + AUTH_CODE_MAX_PER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS);
    expect(blocked.ok).toBe(false);
  });

  it('解禁时刻 = 窗口内**最早**一封滑出窗口（不是最近一封）', () => {
    sendHourly(EMAIL, IP);
    const at = T0 + AUTH_CODE_MAX_PER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS;
    const blocked = admitSend(EMAIL, IP, at);
    if (blocked.ok) throw new Error('预期被拒');
    expect(blocked.retryAfterMs).toBe(T0 + AUTH_CODE_WINDOW_MS - at);
  });

  it('窗口滑出后恢复（滑出后配额是"滚动"的，不是"每小时清零"）', () => {
    sendHourly(EMAIL, IP);
    expect(admitSend(EMAIL, IP, T0 + AUTH_CODE_WINDOW_MS)).toEqual({ ok: true });
  });
});

describe('auth/code-limit — 闸门三：同 IP 每小时封数（防"换邮箱刷"）', () => {
  it('换邮箱能绕过邮箱闸、但绕不过 IP 闸', () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) {
      expect(admitSend(`user${i}@example.com`, IP, T0)).toEqual({ ok: true });
    }
    const blocked = admitSend('another@example.com', IP, T0 + AUTH_CODE_RESEND_INTERVAL_MS);
    expect(blocked.ok).toBe(false);
  });

  it('不同 IP 互不影响', () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) admitSend(`user${i}@example.com`, IP, T0);
    expect(admitSend('x@example.com', '198.51.100.9', T0)).toEqual({ ok: true });
  });

  it('IP 传空串仍受限（**宁可误伤不要放行**：拿不到 IP 正是最该限流的场景）', () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) admitSend(`user${i}@example.com`, '', T0);
    expect(admitSend('x@example.com', '', T0).ok).toBe(false);
  });
});

describe('auth/code-limit — 多道闸同时命中', () => {
  it('返回**最晚**的解禁时刻（取最早会放行一个仍被另一道挡住的请求）', () => {
    const IP_A = '203.0.113.7';
    const IP_B = '198.51.100.9';
    // ① 用别的邮箱把 IP_A 踩满 ⇒ IP_A 那道闸的解禁时刻是 T0 + WINDOW
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) admitSend(`bulk${i}@example.com`, IP_A, T0);
    // ② EMAIL 换 IP_B 发一封 ⇒ 它自己的「最小间隔」闸解禁时刻更晚（T0 + WINDOW + 59s）
    const mailAt = T0 + AUTH_CODE_WINDOW_MS - 1_000;
    expect(admitSend(EMAIL, IP_B, mailAt)).toEqual({ ok: true });

    const blocked = admitSend(EMAIL, IP_A, T0 + AUTH_CODE_WINDOW_MS);
    if (blocked.ok) throw new Error('预期被拒');
    // ★ 取最早（IP_A 那道）会算出 0 ⇒ 当场放行一个间隔还不够的请求
    expect(blocked.retryAfterMs).toBe(AUTH_CODE_RESEND_INTERVAL_MS - 1_000);
  });
});
