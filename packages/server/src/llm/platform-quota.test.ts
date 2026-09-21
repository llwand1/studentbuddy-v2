/**
 * llm/platform-quota 单测（v39，2026-09-21）—— 平台免费通道的**次数**配额。
 *
 * 老板原话：「api 哪里就改成默认零配置，但是有限额，那就是每 5 小时限定 250 次 ai 调用，
 * 然后直接使用我的 key 的额度，但是不让用户看到」。口径（**每次上游请求**计数、
 * **每个用户各 250 次**）与理由见 `@sb/shared/platform-quota` 文件头；本文件只钉行为。
 *
 * ── 两组，手法不同，别混 ──────────────────────────────────────────────────
 * · 「计数层」用**真库**（`openIsolated` 临时目录）：它测的就是 SQL 的窗口与边界，
 *   桩掉库就等于什么都没测。
 * · 「闸门接线」用**spy 计量器**：它测的是**调用时机与分桶键**（assert 在拿槽前、
 *   record 在两槽都拿到后），用 spy 才能精确断言"被调了几次、带的是谁"，且完全不必开库。
 *   反过来若在这里开真库，就分不清"红"是 SQL 写错了还是接线写错了。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import {
  assertPlatformQuota,
  DB_PLATFORM_METER,
  NOOP_PLATFORM_METER,
  platformQuotaState,
  platformUsageCount,
  PlatformQuotaExceededError,
  recordPlatformUsage,
  resetPlatformUsage,
} from './platform-quota.js';
import {
  acquireUpstream,
  resetUpstreamGates,
  setPlatformMeter,
  UPSTREAM_BUSY_MESSAGE,
  UPSTREAM_SITE_MAX_CONCURRENT,
  UPSTREAM_SITE_QUEUE_MAX,
  upstreamStats,
} from './upstream-gate.js';
import { PLATFORM_QUOTA_CODE, PLATFORM_QUOTA_MAX_CALLS, PLATFORM_QUOTA_WINDOW_MS } from '@sb/shared';

const URL_A = 'https://upstream-a.example/v1';

/** 一个钉死的"现在"：本文件所有窗口断言都相对它算，不受用例执行耗时影响。 */
const NOW = 1_700_000_000_000;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pquota-'));
  openIsolated(dir);
  resetUpstreamGates();
  setPlatformMeter(null); // 复原成落库计量器（别的用例可能换过）
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 直接塞用量行（带显式 ts），绕开被测函数本身——窗口边界才测得准。 */
function seedUsage(ownerId: string, count: number, ts: number): void {
  const stmt = getDb().prepare('INSERT INTO platform_usage (owner_id, ts) VALUES (?, ?)');
  const tx = getDb().transaction(() => {
    for (let i = 0; i < count; i++) stmt.run(ownerId, ts);
  });
  tx();
}

/** 发起一次 acquire 但不阻塞，返回"是否已放行 / 报了什么错"的句柄。 */
function probe(baseUrl: string, ownerId: string, platform = true) {
  const state: { admitted: boolean; release?: () => void; error?: Error } = { admitted: false };
  void acquireUpstream(baseUrl, 'main', undefined, { ownerId, platform }).then(
    (release) => {
      state.admitted = true;
      state.release = release;
    },
    (err: Error) => {
      state.error = err;
    },
  );
  return state;
}

/** 冲掉微任务队列（闸门的放行/拒绝都经 Promise） */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ── 一、计数层（真库）───────────────────────────────────────────────────────

describe('v39 计数层：窗口、边界、清理', () => {
  it('常量口径：5 小时 / 250 次（写死在这里，防有人顺手改成"每轮对话"）', () => {
    expect(PLATFORM_QUOTA_WINDOW_MS).toBe(5 * 60 * 60 * 1000);
    expect(PLATFORM_QUOTA_MAX_CALLS).toBe(250);
    expect(PLATFORM_QUOTA_CODE).toBe('PLATFORM_QUOTA_EXCEEDED');
  });

  it('空表：次数 0，状态是"现在就能用"', () => {
    expect(platformUsageCount('u1', NOW)).toBe(0);
    expect(platformQuotaState('u1', NOW)).toEqual({
      used: 0,
      limit: PLATFORM_QUOTA_MAX_CALLS,
      windowStart: NOW,
      resetAt: NOW,
    });
  });

  it('记一笔后：used=1，窗口起点=那笔的时刻，回补时刻=起点+5h', () => {
    recordPlatformUsage('u1', NOW);
    const s = platformQuotaState('u1', NOW);
    expect(s.used).toBe(1);
    expect(s.windowStart).toBe(NOW);
    expect(s.resetAt).toBe(NOW + PLATFORM_QUOTA_WINDOW_MS);
  });

  it('★ 边界：已用 249 时第 250 笔放行，已用 250 时第 251 笔才被拦', () => {
    // 注意口径：`seedUsage` 塞的是**已完成的调用**。故"塞 249"⇒ 下一次是第 250 笔，放行。
    seedUsage('u1', 249, NOW - 1000);
    expect(() => assertPlatformQuota('u1', NOW)).not.toThrow(); // 第 250 笔仍发得出

    seedUsage('u1', 1, NOW - 1000);
    expect(platformUsageCount('u1', NOW)).toBe(250);
    expect(() => assertPlatformQuota('u1', NOW)).toThrow(PlatformQuotaExceededError); // 第 251 笔被拦
  });

  it('★ 窗口边界是**开区间**：恰好 5 小时前那笔已滑出（否则额度会永久卡死）', () => {
    seedUsage('u1', 250, NOW - PLATFORM_QUOTA_WINDOW_MS); // 恰好落在窗口下界上
    expect(platformUsageCount('u1', NOW)).toBe(0);
    expect(() => assertPlatformQuota('u1', NOW)).not.toThrow();
  });

  it('★ 滚动窗口语义：旧笔逐笔滑出，不是"到点一次性重置"', () => {
    seedUsage('u1', 250, NOW - PLATFORM_QUOTA_WINDOW_MS + 1000); // 还差 1s 才滑出
    expect(platformUsageCount('u1', NOW)).toBe(250);
    expect(platformUsageCount('u1', NOW + 1000)).toBe(0); // 过 1s 全滑出
    // 混合：一半新一半旧 ⇒ 只数新的那一半
    seedUsage('u2', 100, NOW - PLATFORM_QUOTA_WINDOW_MS - 1); // 已滑出
    seedUsage('u2', 30, NOW - 1); // 在窗口内
    expect(platformUsageCount('u2', NOW)).toBe(30);
  });

  it('★ 抛出的错带可读文案、错误码与"最早那笔何时回补"', () => {
    seedUsage('u1', 250, NOW - 1000);
    try {
      assertPlatformQuota('u1', NOW);
      expect.unreachable('应当抛出');
    } catch (err) {
      const e = err as PlatformQuotaExceededError;
      expect(e).toBeInstanceOf(PlatformQuotaExceededError);
      expect(e.code).toBe(PLATFORM_QUOTA_CODE);
      expect(e.retryAfterMs).toBe(PLATFORM_QUOTA_WINDOW_MS - 1000); // 最早那笔 + 5h - now
      expect(e.message).toContain('250');
      expect(e.message).toContain('设置页'); // ADR-5：失败必须指向**下一步动作**，不是"稍后再试"
    }
  });

  it('record 顺带清掉**本用户**已滑出的旧行（表不随使用无限膨胀）', () => {
    seedUsage('u1', 5, NOW - PLATFORM_QUOTA_WINDOW_MS - 1);
    recordPlatformUsage('u1', NOW);
    const left = getDb().prepare('SELECT COUNT(*) AS c FROM platform_usage WHERE owner_id = ?').get('u1') as {
      c: number;
    };
    expect(left.c).toBe(1); // 旧的 5 行没了，只剩刚记的这 1 行
  });

  it('★ record 只清**自己**的旧行，不误删别人的（全表 DELETE 会在大盘上变成一把大锁）', () => {
    seedUsage('u1', 3, NOW - PLATFORM_QUOTA_WINDOW_MS - 1);
    seedUsage('u2', 3, NOW - PLATFORM_QUOTA_WINDOW_MS - 1);
    recordPlatformUsage('u1', NOW);
    const u2 = getDb().prepare('SELECT COUNT(*) AS c FROM platform_usage WHERE owner_id = ?').get('u2') as {
      c: number;
    };
    expect(u2.c).toBe(3); // u2 的旧行一根没动
  });

  it('★ 分桶键是**请求者**：A 打满不影响 B（挤同一个桶就退化成"全站 250"）', () => {
    seedUsage('A', 250, NOW - 1000);
    expect(() => assertPlatformQuota('A', NOW)).toThrow(PlatformQuotaExceededError);
    expect(() => assertPlatformQuota('B', NOW)).not.toThrow();
    expect(platformQuotaState('B', NOW).used).toBe(0);
  });

  it('resetPlatformUsage 清空全表（仅测试用）', () => {
    recordPlatformUsage('u1', NOW);
    recordPlatformUsage('u2', NOW);
    resetPlatformUsage();
    expect(platformUsageCount('u1', NOW)).toBe(0);
    expect(platformUsageCount('u2', NOW)).toBe(0);
  });

  it('NOOP 计量器真的什么都不做（它若偷偷落库，纯逻辑用例会开真库）', () => {
    NOOP_PLATFORM_METER.assert('u1');
    NOOP_PLATFORM_METER.record('u1');
    expect(platformUsageCount('u1', NOW)).toBe(0);
  });

  it('DB 计量器就是落库实现（默认值必须 fail-closed）', () => {
    DB_PLATFORM_METER.record('u1');
    expect(platformUsageCount('u1', Date.now())).toBe(1);
  });
});

// ── 二、闸门接线（spy 计量器，不落库）────────────────────────────────────────

describe('v39 闸门接线：assert 在拿槽前、record 在两槽后', () => {
  /** 记账型计量器：只记录"被谁、以什么顺序调了"，不做任何判断也不落库。 */
  function spyMeter() {
    return { assert: vi.fn(), record: vi.fn() };
  }

  it('★ 计量键是**请求者**（不是 provider 的 owner —— 平台行 owner 恒为 NULL）', async () => {
    const spy = spyMeter();
    setPlatformMeter(spy);
    const r = await acquireUpstream(URL_A, 'main', undefined, { ownerId: 'uA', platform: true });
    expect(spy.assert).toHaveBeenCalledWith('uA');
    expect(spy.record).toHaveBeenCalledWith('uA');
    r();
  });

  it('★ 超限（assert 抛）时**一个槽都没占**：内层/外层计数与队列全为 0', async () => {
    setPlatformMeter({
      assert: () => {
        throw new PlatformQuotaExceededError(1000);
      },
      record: vi.fn(),
    });
    await expect(acquireUpstream(URL_A, 'main', undefined, { ownerId: 'uA', platform: true })).rejects.toBeInstanceOf(
      PlatformQuotaExceededError,
    );
    // ★ 额度用完的用户不该占着并发桶，否则会把正常用户挡在门外
    expect(upstreamStats(URL_A, 'uA').inFlight).toBe(0);
    expect(upstreamStats(URL_A).siteInFlight).toBe(0);
    expect(upstreamStats(URL_A).sitePending).toBe(0);
  });

  it('★ 被外层闸门拒绝的请求**不计费**：8 笔在飞记 8 次，20 笔排队不记，第 29 笔被拒也不记', async () => {
    const spy = spyMeter();
    setPlatformMeter(spy);
    // 前 8 个用**不同**用户占满外层在飞位（每人内层只占 1，不会先被内层挡住）
    const held: Array<() => void> = [];
    for (let i = 0; i < UPSTREAM_SITE_MAX_CONCURRENT; i++) {
      held.push(await acquireUpstream(URL_A, 'main', undefined, { ownerId: `u${i}`, platform: true }));
    }
    // 后 20 个排进外层队列 —— ★ 必须用**非阻塞**探针：`await` 它们会永远等不到放行（死锁）
    for (let i = 0; i < UPSTREAM_SITE_QUEUE_MAX; i++) probe(URL_A, `w${i}`);
    await tick();
    expect(spy.record).toHaveBeenCalledTimes(UPSTREAM_SITE_MAX_CONCURRENT); // ★ 排队的没计费

    const overflow = probe(URL_A, 'u-overflow');
    await tick();
    expect(overflow.admitted).toBe(false);
    expect(overflow.error?.message).toBe(UPSTREAM_BUSY_MESSAGE);
    expect(spy.assert).toHaveBeenCalledTimes(UPSTREAM_SITE_MAX_CONCURRENT + UPSTREAM_SITE_QUEUE_MAX + 1); // 断言都过了
    expect(spy.record).toHaveBeenCalledTimes(UPSTREAM_SITE_MAX_CONCURRENT); // ★ 但都没计费：用户没得到服务

    held.forEach((r) => r());
    await tick();
  });

  it('★ 外层排队中被停止 ⇒ 同样不计费（拿不到槽就不该扣次数）', async () => {
    const spy = spyMeter();
    setPlatformMeter(spy);
    const held: Array<() => void> = [];
    for (let i = 0; i < UPSTREAM_SITE_MAX_CONCURRENT; i++) {
      held.push(await acquireUpstream(URL_A, 'main', undefined, { ownerId: `u${i}`, platform: true }));
    }
    expect(spy.record).toHaveBeenCalledTimes(UPSTREAM_SITE_MAX_CONCURRENT);

    const ac = new AbortController();
    const queued = acquireUpstream(URL_A, 'main', ac.signal, { ownerId: 'waiter', platform: true });
    await tick();
    ac.abort();
    await expect(queued).rejects.toThrow('已停止');
    expect(spy.record).toHaveBeenCalledTimes(UPSTREAM_SITE_MAX_CONCURRENT); // 没多记

    held.forEach((r) => r());
  });

  it('★ BYOK（platform=false）既不断言也不计数：用户自己的钱不该吃平台额度', async () => {
    const spy = spyMeter();
    setPlatformMeter(spy);
    const r = await acquireUpstream(URL_A, 'main', undefined, { ownerId: 'uA', platform: false });
    expect(spy.assert).not.toHaveBeenCalled();
    expect(spy.record).not.toHaveBeenCalled();
    r();
  });

  it('★ 未登录（platform=true 且 ownerId=null）不计数：本地单人模式不吃额度', async () => {
    const spy = spyMeter();
    setPlatformMeter(spy);
    const r = await acquireUpstream(URL_A, 'main', undefined, { ownerId: null, platform: true });
    expect(spy.assert).not.toHaveBeenCalled();
    expect(spy.record).not.toHaveBeenCalled();
    r();
  });

  it('★ 不带 quota（缺省 = 未登录平台通道）同样不计数', async () => {
    const spy = spyMeter();
    setPlatformMeter(spy);
    const r = await acquireUpstream(URL_A);
    expect(spy.assert).not.toHaveBeenCalled();
    expect(spy.record).not.toHaveBeenCalled();
    r();
  });
});

// ── 三、端到端：真闸门 + 真库（唯一一条走完整链的用例）──────────────────────

describe('v39 端到端：第 251 次上游调用被闸门拦下', () => {
  it('★ 打满 250 次后，第 251 次抛 PlatformQuotaExceededError；B 用户不受影响', async () => {
    // 逐笔 acquire 后立刻 release：既把 250 笔记满，又不撞并发闸门的容量
    for (let i = 0; i < PLATFORM_QUOTA_MAX_CALLS; i++) {
      const release = await acquireUpstream(URL_A, 'main', undefined, { ownerId: 'uA', platform: true });
      release();
    }
    expect(platformUsageCount('uA')).toBe(PLATFORM_QUOTA_MAX_CALLS);

    await expect(
      acquireUpstream(URL_A, 'main', undefined, { ownerId: 'uA', platform: true }),
    ).rejects.toBeInstanceOf(PlatformQuotaExceededError);

    // 被拒的那笔没占槽（否则正常用户会被"额度用完的人"挡在门外）
    expect(upstreamStats(URL_A, 'uA').inFlight).toBe(0);
    expect(upstreamStats(URL_A).siteInFlight).toBe(0);

    // ★ 别人的额度是另一份：B 照常放行
    const b = await acquireUpstream(URL_A, 'main', undefined, { ownerId: 'uB', platform: true });
    b();
    expect(platformUsageCount('uB')).toBe(1);
  });
});
