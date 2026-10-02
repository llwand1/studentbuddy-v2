/**
 * llm/platform-budget 单测（v53，2026-10-02）—— 平台通道的**全站每日**成本闸。
 *
 * 契约 `docs/TENANCY-SPEC.md` §8.1.3.4；口径（每次上游调用、不分用户、先断言后计数）见
 * `platform-budget.ts` 文件头。本文件用**真库**（`openIsolated` 临时目录）：它测的就是
 * SQL 的 UPSERT 自增、跨日归零与"只留当天"的清理——桩掉库等于什么都没测。
 *
 * ★ 时间全用**显式 now**（不依赖 `Date.now()`）：跨日与 retryAfterMs 的断言要钉死到具体时刻，
 *   否则用例执行耗时会让边界漂移。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localDayKey, PLATFORM_BUDGET_ENV, PLATFORM_BUDGET_MESSAGE, PLATFORM_QUOTA_CODE } from '@sb/shared';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import { PlatformQuotaExceededError } from './platform-quota.js';
import {
  assertSiteBudget,
  recordSiteCall,
  resetSiteBudget,
  siteBudgetMax,
  siteCallsToday,
} from './platform-budget.js';

/** 本地时区下的两个不同日、以及一个"当天 23:30"（算 retryAfterMs 用）。 */
const DAY1 = new Date(2026, 0, 1, 12, 0, 0).getTime();
const DAY2 = new Date(2026, 0, 2, 12, 0, 0).getTime();
const DAY1_LATE = new Date(2026, 0, 1, 23, 30, 0).getTime();
const DAY1_KEY = localDayKey(new Date(DAY1));

let dir: string;

/** 临时改 env，用完还原（env 是进程级全局，漏还原会污染同文件其它用例）。 */
function withEnv(value: string | undefined, fn: () => void): void {
  const saved = process.env[PLATFORM_BUDGET_ENV];
  if (value === undefined) delete process.env[PLATFORM_BUDGET_ENV];
  else process.env[PLATFORM_BUDGET_ENV] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[PLATFORM_BUDGET_ENV];
    else process.env[PLATFORM_BUDGET_ENV] = saved;
  }
}

/** 直接写一行当天用量（绕开被测函数，边界才测得准）；同一天重复调用即覆盖为指定值。 */
function seedDay(day: string, calls: number): void {
  getDb()
    .prepare('INSERT INTO platform_call_day (day, calls) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET calls = excluded.calls')
    .run(day, calls);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-budget-'));
  openIsolated(dir);
  delete process.env[PLATFORM_BUDGET_ENV];
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env[PLATFORM_BUDGET_ENV];
});

describe('v53 全站每日上限：解析与默认值', () => {
  it('未配 ⇒ 默认 10000；off ⇒ 不限；数字 ⇒ 该数（每次现读 env）', () => {
    expect(siteBudgetMax()).toBe(10000);
    withEnv('off', () => expect(siteBudgetMax()).toBeNull());
    withEnv('5000', () => expect(siteBudgetMax()).toBe(5000));
  });

  it('★ 非法值 ⇒ 10000（宁可限额、不静默放开），且真的按 10000 拦', () => {
    withEnv('abc', () => {
      expect(siteBudgetMax()).toBe(10000);
      seedDay(DAY1_KEY, 10000);
      expect(() => assertSiteBudget(DAY1)).toThrow(PlatformQuotaExceededError);
    });
  });

  it('空表：当天 0 笔，断言放行', () => {
    expect(siteCallsToday(DAY1)).toBe(0);
    withEnv('3', () => expect(() => assertSiteBudget(DAY1)).not.toThrow());
  });
});

describe('v53 计数：UPSERT 自增、跨日归零、只留当天', () => {
  it('同一天连记两笔 ⇒ 累计为 2（UPSERT 自增，不是覆盖）', () => {
    recordSiteCall(DAY1);
    recordSiteCall(DAY1);
    expect(siteCallsToday(DAY1)).toBe(2);
  });

  it('★ 跨日归零：次日的读数是 0（日键换了）', () => {
    recordSiteCall(DAY1);
    recordSiteCall(DAY1);
    expect(siteCallsToday(DAY2)).toBe(0);
    recordSiteCall(DAY2);
    expect(siteCallsToday(DAY2)).toBe(1);
  });

  it('★ 记一笔顺手只留当天：旧日行被清掉（表恒为 0~1 行，不随天数增长）', () => {
    seedDay('2025-12-31', 7); // 前一天残留
    recordSiteCall(DAY1);
    const rows = getDb().prepare('SELECT day, calls FROM platform_call_day').all() as Array<{ day: string; calls: number }>;
    expect(rows).toEqual([{ day: DAY1_KEY, calls: 1 }]);
  });

  it('resetSiteBudget 清空全表（仅测试用）', () => {
    recordSiteCall(DAY1);
    resetSiteBudget();
    expect(siteCallsToday(DAY1)).toBe(0);
  });
});

describe('v53 断言边界与错误形状', () => {
  it('★ 边界：已用 2（max 3）放行，已用 3 才拒（前 max 笔发出）', () => {
    withEnv('3', () => {
      seedDay(DAY1_KEY, 2);
      expect(() => assertSiteBudget(DAY1)).not.toThrow(); // 第 3 笔仍发得出
      seedDay(DAY1_KEY, 3);
      expect(() => assertSiteBudget(DAY1)).toThrow(PlatformQuotaExceededError); // 第 4 笔被拦
    });
  });

  it('★ off ⇒ 不限：已用远超默认值也不抛', () => {
    withEnv('off', () => {
      seedDay(DAY1_KEY, 999_999);
      expect(() => assertSiteBudget(DAY1)).not.toThrow();
    });
  });

  it('★ 抛出的错：复用 PLATFORM_QUOTA_CODE、文案是 PLATFORM_BUDGET_MESSAGE、retryAfterMs 指向本地明日 0 点', () => {
    withEnv('1', () => {
      seedDay(DAY1_KEY, 1);
      try {
        assertSiteBudget(DAY1_LATE);
        expect.unreachable('应当抛出');
      } catch (err) {
        const e = err as PlatformQuotaExceededError;
        expect(e).toBeInstanceOf(PlatformQuotaExceededError);
        expect(e.code).toBe(PLATFORM_QUOTA_CODE); // ★ 复用同一码：上层据它给"去配自己的模型"
        expect(e.message).toBe(PLATFORM_BUDGET_MESSAGE);
        // 23:30 → 次日 00:00 = 30 分钟
        expect(e.retryAfterMs).toBe(30 * 60 * 1000);
      }
    });
  });
});