/**
 * auth/code-limit 测试：**纯内存、零 IO 零 DB**（契约 docs/AUTH-SPEC.md §4.5 / §2.7）。
 *
 * 三道闸门全在这一层钉死，理由与 `shared/ebbinghaus.test.ts` 同：限流的正确性**只有边界**，
 * 而边界跑在真端点里既慢又要造一堆用户。时间一律注入 `now`。
 *
 * ★ 本文件守着三个容易被"优化"掉的语义：
 *   ① **被拒的请求不记账**。若改成"先记账再判"，被刷时窗口会不断后移，正常用户
 *      **一小时内永远等不到窗口滑出**（越刷越封），而这类退化不会让任何别的测试报红。
 *   ② **三道闸的作用域两两不同**（M1.6 起）——判据是"这道闸门到底在挡什么"：
 *      · 最小间隔按 `用途:邮箱`（挡"同一个动作连点"；`register` 与 `login` 是两个动作）
 *      · 每小时封数按**邮箱、跨用途共用**（挡"把某个邮箱炸了"，与用途无关）
 *      · IP 封数按 `用途:IP`（`register` 是唯一给未注册地址发信的用途，滥用面大一个量级）
 *      **每个方向都要有测试**，否则后人"统一一下"就会静默破坏其中一侧——
 *      而这类破坏的症状全是**产品级的**（"等 60 秒" / "校园网里所有人登不进来"）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AUTH_CODE_MAX_PER_HOUR,
  AUTH_CODE_MAX_PER_IP_HOUR,
  AUTH_CODE_MAX_PER_IP_REGISTER_HOUR,
  AUTH_CODE_RESEND_INTERVAL_MS,
  AUTH_CODE_WINDOW_MS,
} from '@sb/shared';
import { admitSend, resetCodeLimits } from './code-limit.js';

const EMAIL = 'a@example.com';
const IP = '203.0.113.7';
const IP_B = '198.51.100.9';

/** 便于读的常量：窗口起点。 */
const T0 = 1_000_000;

beforeEach(() => {
  resetCodeLimits();
});

describe('auth/code-limit — 闸门一：同邮箱最小间隔', () => {
  it('首次放行；间隔内再发被拒，且 `retryAfterMs` 正好指到解禁时刻', () => {
    expect(admitSend(EMAIL, IP, 'login', T0)).toEqual({ ok: true });
    const blocked = admitSend(EMAIL, IP, 'login', T0 + 1);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('预期被拒');
    expect(blocked.retryAfterMs).toBe(AUTH_CODE_RESEND_INTERVAL_MS - 1);
  });

  it('间隔一到即放行（边界：正好等于间隔通过）', () => {
    admitSend(EMAIL, IP, 'login', T0);
    expect(admitSend(EMAIL, IP, 'login', T0 + AUTH_CODE_RESEND_INTERVAL_MS)).toEqual({ ok: true });
  });

  it('**被拒的请求不记账**：连刷 100 次不会把窗口一路后移', () => {
    admitSend(EMAIL, IP, 'login', T0);
    for (let i = 1; i <= 100; i += 1) admitSend(EMAIL, IP, 'login', T0 + i);
    // 若"先记账再判"，第 2 次起每次都会刷新最近时刻 ⇒ 这里必然被拒
    expect(admitSend(EMAIL, IP, 'login', T0 + AUTH_CODE_RESEND_INTERVAL_MS)).toEqual({ ok: true });
  });

  it('不同邮箱互不影响（闸门按邮箱分桶）', () => {
    admitSend(EMAIL, IP, 'login', T0);
    expect(admitSend('b@example.com', IP, 'login', T0 + 1)).toEqual({ ok: true });
  });

  it('★★ 最小间隔**按用途分开**：`register` 刚发过，同一邮箱的 `login` 立刻能发', () => {
    // 这条守的是一条**真实产品路径**：拿已注册邮箱点注册 → 409 `EMAIL_TAKEN`（填错邮箱，当场告知）
    // → 切到登录页点发送验证码。把两条规则从一个数组推导的实现会在这里红，
    // 而症状是「用户刚被拒过，又被要求等 60 秒」——摩擦落在最坏的时刻。
    expect(admitSend(EMAIL, IP, 'register', T0)).toEqual({ ok: true });
    expect(admitSend(EMAIL, IP, 'login', T0 + 1)).toEqual({ ok: true });
  });

  it('★ 反向也成立：`login` 刚发过，`register` 立刻能发', () => {
    expect(admitSend(EMAIL, IP, 'login', T0)).toEqual({ ok: true });
    expect(admitSend(EMAIL, IP, 'register', T0 + 1)).toEqual({ ok: true });
  });

  it('★ 分开的是**用途**，不是取消间隔：同一用途的连点照样被挡', () => {
    expect(admitSend(EMAIL, IP, 'register', T0)).toEqual({ ok: true });
    const again = admitSend(EMAIL, IP, 'register', T0 + 1);
    expect(again.ok).toBe(false);
  });

  it('★★ 用途分开**不等于**放开发信量：每小时封数仍跨用途共用（三个用途不能各发 5 封）', () => {
    // 用 5 个不同 IP、5 个不同间隔把**每小时封数**用满（排除 IP 桶与间隔闸的干扰）
    for (let i = 0; i < AUTH_CODE_MAX_PER_HOUR; i += 1) {
      expect(admitSend(EMAIL, `10.0.0.${i}`, 'login', T0 + i * AUTH_CODE_RESEND_INTERVAL_MS)).toEqual({ ok: true });
    }
    // 换个**用途** + 干净 IP：仍被拦 ⇒ 拦它的只能是"每小时封数"那道共用闸。
    // 若哪天把这条也按用途拆开，对单个邮箱的骚扰上限就从 5 变成 15，
    // 且 `AUTH_CODE_MAX_PER_HOUR` 与发信厂商额度的那笔账会失真。
    const blocked = admitSend(EMAIL, IP_B, 'register', T0 + AUTH_CODE_MAX_PER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS);
    expect(blocked.ok).toBe(false);
  });
});

describe('auth/code-limit — 闸门二：同邮箱每小时封数', () => {
  /** 间隔地发满 `AUTH_CODE_MAX_PER_HOUR` 封。 */
  function sendHourly(email: string, ip: string, purpose: 'login' | 'register' = 'login'): void {
    for (let i = 0; i < AUTH_CODE_MAX_PER_HOUR; i += 1) {
      const r = admitSend(email, ip, purpose, T0 + i * AUTH_CODE_RESEND_INTERVAL_MS);
      expect(r).toEqual({ ok: true });
    }
  }

  it(`第 ${AUTH_CODE_MAX_PER_HOUR} 封之后被拒（间隔都够，是**封数**这道闸拦下的）`, () => {
    sendHourly(EMAIL, IP);
    const blocked = admitSend(EMAIL, IP, 'login', T0 + AUTH_CODE_MAX_PER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS);
    expect(blocked.ok).toBe(false);
  });

  it('解禁时刻 = 窗口内**最早**一封滑出窗口（不是最近一封）', () => {
    sendHourly(EMAIL, IP);
    const at = T0 + AUTH_CODE_MAX_PER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS;
    const blocked = admitSend(EMAIL, IP, 'login', at);
    if (blocked.ok) throw new Error('预期被拒');
    expect(blocked.retryAfterMs).toBe(T0 + AUTH_CODE_WINDOW_MS - at);
  });

  it('窗口滑出后恢复（滑出后配额是"滚动"的，不是"每小时清零"）', () => {
    sendHourly(EMAIL, IP);
    expect(admitSend(EMAIL, IP, 'login', T0 + AUTH_CODE_WINDOW_MS)).toEqual({ ok: true });
  });

  it('★ 邮箱桶**跨用途共用**：拿 `register` 发满后，同一邮箱的 `login` 也发不出', () => {
    sendHourly(EMAIL, IP, 'register');
    // 换一个干净 IP，排除 IP 桶干扰 ⇒ 唯一可能的拦截者是邮箱桶
    const blocked = admitSend(EMAIL, IP_B, 'login', T0 + AUTH_CODE_MAX_PER_HOUR * AUTH_CODE_RESEND_INTERVAL_MS);
    expect(blocked.ok).toBe(false);
  });
});

describe('auth/code-limit — 闸门三：同 IP 每小时封数（防"换邮箱刷"）', () => {
  it('换邮箱能绕过邮箱闸、但绕不过 IP 闸', () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) {
      expect(admitSend(`user${i}@example.com`, IP, 'login', T0)).toEqual({ ok: true });
    }
    const blocked = admitSend('another@example.com', IP, 'login', T0 + AUTH_CODE_RESEND_INTERVAL_MS);
    expect(blocked.ok).toBe(false);
  });

  it('不同 IP 互不影响', () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) admitSend(`user${i}@example.com`, IP, 'login', T0);
    expect(admitSend('x@example.com', IP_B, 'login', T0)).toEqual({ ok: true });
  });

  it('IP 传空串仍受限（**宁可误伤不要放行**：拿不到 IP 正是最该限流的场景）', () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) admitSend(`user${i}@example.com`, '', 'login', T0);
    expect(admitSend('x@example.com', '', 'login', T0).ok).toBe(false);
  });
});

describe('auth/code-limit — M1.6：register 的 IP 桶单独更严，且与 login **不共用**', () => {
  it(`register 的 IP 上限是 ${AUTH_CODE_MAX_PER_IP_REGISTER_HOUR}（换邮箱也绕不过）`, () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_REGISTER_HOUR; i += 1) {
      expect(admitSend(`r${i}@example.com`, IP, 'register', T0)).toEqual({ ok: true });
    }
    const blocked = admitSend('r-extra@example.com', IP, 'register', T0 + AUTH_CODE_RESEND_INTERVAL_MS);
    expect(blocked.ok).toBe(false);
  });

  it('★★ 注册被刷满**不会**掐死同一出口 IP 上的验证码登录（分桶的全部理由）', () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_REGISTER_HOUR; i += 1) admitSend(`r${i}@example.com`, IP, 'register', T0);
    expect(admitSend('r-extra@example.com', IP, 'register', T0).ok).toBe(false); // register 已满
    // ★ 共用桶的实现会在这里红——而症状是"校园网 / 公司网里所有人都登不进来"
    expect(admitSend('l@example.com', IP, 'login', T0)).toEqual({ ok: true });
  });

  it('★ 反向也成立：login 的 IP 桶被踩满，不影响 register', () => {
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) admitSend(`l${i}@example.com`, IP, 'login', T0);
    expect(admitSend('l-extra@example.com', IP, 'login', T0).ok).toBe(false);
    expect(admitSend('r@example.com', IP, 'register', T0)).toEqual({ ok: true });
  });
});

describe('auth/code-limit — 多道闸同时命中', () => {
  it('返回**最晚**的解禁时刻（取最早会放行一个仍被另一道挡住的请求）', () => {
    const IP_A = '203.0.113.7';
    // ① 用别的邮箱把 IP_A 踩满 ⇒ IP_A 那道闸的解禁时刻是 T0 + WINDOW
    for (let i = 0; i < AUTH_CODE_MAX_PER_IP_HOUR; i += 1) admitSend(`bulk${i}@example.com`, IP_A, 'login', T0);
    // ② EMAIL 换 IP_B 发一封 ⇒ 它自己的「最小间隔」闸解禁时刻更晚（T0 + WINDOW + 59s）
    const mailAt = T0 + AUTH_CODE_WINDOW_MS - 1_000;
    expect(admitSend(EMAIL, IP_B, 'login', mailAt)).toEqual({ ok: true });

    const blocked = admitSend(EMAIL, IP_A, 'login', T0 + AUTH_CODE_WINDOW_MS);
    if (blocked.ok) throw new Error('预期被拒');
    // ★ 取最早（IP_A 那道）会算出 0 ⇒ 当场放行一个间隔还不够的请求
    expect(blocked.retryAfterMs).toBe(AUTH_CODE_RESEND_INTERVAL_MS - 1_000);
  });
});
