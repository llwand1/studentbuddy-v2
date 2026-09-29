/**
 * fsrs — FSRS-5 纯函数：曲线定义、间隔反推、状态更新的方向性（不锁具体小数，锁性质）。
 */
import { describe, it, expect } from 'vitest';
import {
  FSRS_MAX_INTERVAL,
  fsrsFromLegacy,
  fsrsInit,
  fsrsInterval,
  fsrsNext,
  fsrsRetrievability,
  gradeFromRemembered,
  isFsrsGrade,
} from './fsrs.js';
import { computeReviewState } from './ebbinghaus.js';

describe('曲线与间隔', () => {
  it('★ 稳定性的定义：过 S 天可提取度恰为 0.9；刚复习为 1；随时间单调下降', () => {
    expect(fsrsRetrievability(10, 10)).toBeCloseTo(0.9, 6);
    expect(fsrsRetrievability(0, 10)).toBe(1);
    expect(fsrsRetrievability(5, 10)).toBeGreaterThan(fsrsRetrievability(20, 10));
  });
  it('目标保持率 0.9 时间隔 ≈ S；保持率要求越高间隔越短；≥1 天、封顶一年', () => {
    expect(fsrsInterval(12)).toBe(12);
    expect(fsrsInterval(12, 0.95)).toBeLessThan(fsrsInterval(12, 0.85));
    expect(fsrsInterval(0.1)).toBe(1);
    expect(fsrsInterval(99999)).toBe(FSRS_MAX_INTERVAL);
  });
});

describe('状态更新', () => {
  it('首次复习：评分越高稳定性越大、难度越低', () => {
    const [a, h, g, e] = ([1, 2, 3, 4] as const).map((x) => fsrsInit(x));
    expect(a!.stability).toBeLessThan(h!.stability);
    expect(g!.stability).toBeLessThan(e!.stability);
    expect(a!.difficulty).toBeGreaterThan(e!.difficulty);
  });
  it('★ 记住 ⇒ 稳定性增长；忘了 ⇒ 稳定性下降且不高于原值、难度上升', () => {
    const s = { stability: 10, difficulty: 5 };
    expect(fsrsNext(s, 3, 10).stability).toBeGreaterThan(10);
    const f = fsrsNext(s, 1, 10);
    expect(f.stability).toBeLessThan(10);
    expect(f.difficulty).toBeGreaterThan(5);
  });
  it('★ 越是快忘时想起来，稳定性涨得越多（间隔效应）', () => {
    const s = { stability: 10, difficulty: 5 };
    expect(fsrsNext(s, 3, 20).stability).toBeGreaterThan(fsrsNext(s, 3, 2).stability);
  });
  it('难词涨得慢；困难 < 记得 < 轻松', () => {
    expect(fsrsNext({ stability: 10, difficulty: 9 }, 3, 10).stability).toBeLessThan(fsrsNext({ stability: 10, difficulty: 3 }, 3, 10).stability);
    const [h, g, e] = ([2, 3, 4] as const).map((x) => fsrsNext({ stability: 10, difficulty: 5 }, x, 10).stability);
    expect(h).toBeLessThan(g!);
    expect(g).toBeLessThan(e!);
  });
  it('难度钳在 1–10', () => {
    let s = { stability: 5, difficulty: 9.9 };
    for (let i = 0; i < 20; i += 1) s = fsrsNext(s, 1, 1);
    expect(s.difficulty).toBeLessThanOrEqual(10);
    let t = { stability: 5, difficulty: 1.1 };
    for (let i = 0; i < 20; i += 1) t = fsrsNext(t, 4, 5);
    expect(t.difficulty).toBeGreaterThanOrEqual(1);
  });
});

describe('旧数据迁入与接入口', () => {
  it('★ 旧曲线在到期日保持率 0.7：折算出的 S 在旧间隔那天给出 0.7', () => {
    const s = fsrsFromLegacy(15);
    expect(fsrsRetrievability(15, s.stability)).toBeCloseTo(0.7, 6);
    expect(s.difficulty).toBe(5);
  });
  it('两键折算与评分守卫', () => {
    expect(gradeFromRemembered(true)).toBe(3);
    expect(gradeFromRemembered(false)).toBe(1);
    expect([0, 1, 4, 5, '3', 2.5].map(isFsrsGrade)).toEqual([false, true, true, false, false, false]);
  });
  it('★ computeReviewState：有稳定性 ⇒ 间隔与保持率走 FSRS 且带出 S/D；没有 ⇒ 旧口径且不多出字段', () => {
    const now = new Date(2026, 8, 29, 12);
    const last = '2026-09-19 04:00:00'; // 10 天前（UTC 文本）
    const f = computeReviewState({ lastReviewedAt: last, stage: 2, now, stability: 20, difficulty: 6 });
    expect(f.intervalDays).toBe(20);
    expect(f.retention).toBeCloseTo(fsrsRetrievability(10, 20), 6);
    expect(f).toMatchObject({ stability: 20, difficulty: 6, status: 'upcoming' });
    const legacy = computeReviewState({ lastReviewedAt: last, stage: 2, now });
    expect(legacy.intervalDays).toBe(4);
    expect('stability' in legacy).toBe(false);
  });
  it('从没复习过（只有入库时间）时即使传了稳定性也不走 FSRS', () => {
    const r = computeReviewState({ createdAt: '2026-09-28 00:00:00', stage: 0, now: new Date(2026, 8, 29, 12), stability: 30 });
    expect(r.intervalDays).toBe(1);
  });
});
