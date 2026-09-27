/**
 * shared/ebbinghaus — 艾宾浩斯契约回归（纯函数，无 IO）。
 *
 * 锁的是「**今天该不该复习**」这个判定的全部边界：天数怎么算、什么时候算到期、
 * 忘了要不要归零、保持率是否到期恰好 70%。这些数错一个，用户看到的就是
 * 「明明逾期三天却说还有一天」这种当场露馅的错误，故逐条钉死。
 */
import { describe, it, expect } from 'vitest';
import {
  computeReviewState,
  parseSqliteDate,
  localDayIndex,
  localDayKey,
  addDays,
  reviewIntervalDays,
  retentionAt,
  nextStage,
  reviewStateLabel,
  MAX_REVIEW_STAGE,
  REVIEW_INTERVALS_DAYS,
  DUE_RETENTION,
} from './ebbinghaus.js';

const NOW = new Date(2026, 8, 17, 10, 0, 0); // 2026-09-17 10:00 本地

describe('shared/ebbinghaus — 间隔序列', () => {
  it('七个经典节点：1/2/4/7/15/30/60 天，下标即 stage', () => {
    expect(REVIEW_INTERVALS_DAYS).toEqual([1, 2, 4, 7, 15, 30, 60]);
    expect(reviewIntervalDays(0)).toBe(1);
    expect(reviewIntervalDays(3)).toBe(7);
    expect(reviewIntervalDays(6)).toBe(60);
  });

  it('越界钳到两端（负数当 0、超界取最后一段）——调用方不必到处判空', () => {
    expect(reviewIntervalDays(-5)).toBe(1);
    expect(reviewIntervalDays(99)).toBe(60);
    expect(reviewIntervalDays(1.9)).toBe(2);
  });
});

describe('shared/ebbinghaus — 天数按本地日历日（不是满 24 小时）', () => {
  it('SQLite 文本按 UTC 解析', () => {
    const d = parseSqliteDate('2026-09-14 12:00:00');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2026-09-14T12:00:00.000Z');
    expect(parseSqliteDate('')).toBeNull();
    expect(parseSqliteDate('not-a-date')).toBeNull();
    expect(parseSqliteDate(null)).toBeNull();
  });

  it('差一天半也只算「一天前」——日历日口径', () => {
    // 库里 09-16 15:00Z，现在本地 09-17 00:30：真实间隔可能只有几小时，但日历上就是昨天
    const s = computeReviewState({ lastReviewedAt: '2026-09-16 15:00:00', now: new Date(2026, 8, 17, 0, 30) });
    expect(s.daysSince).toBe(1);
  });

  it('localDayKey / addDays 跨月跨年正确', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-09-17', -20)).toBe('2026-08-28');
    expect(localDayIndex(new Date(2026, 8, 17, 0, 0))).toBe(localDayIndex(new Date(2026, 8, 17, 23, 59)));
  });
});

describe('shared/ebbinghaus — 复习状态判定', () => {
  it('刚入库（没复习过）：起算点退到 created_at，1 天后才到期', () => {
    const s = computeReviewState({ createdAt: '2026-09-17 02:00:00', now: NOW });
    expect(s.basis).toBe('created');
    expect(s.daysSince).toBe(0);
    expect(s.status).toBe('upcoming');
    expect(s.dueInDays).toBe(1);
    expect(s.overdueDays).toBe(0);
    expect(s.nextDueDay).toBe('2026-09-18');
  });

  it('正好到间隔那天 = due（今天该复习），还没逾期', () => {
    const s = computeReviewState({ lastReviewedAt: '2026-09-16 12:00:00', now: NOW });
    expect(s.basis).toBe('review');
    expect(s.daysSince).toBe(1);
    expect(s.status).toBe('due');
    expect(s.overdueDays).toBe(0);
  });

  it('超过间隔 = overdue，逾期天数 = 超出部分', () => {
    const s = computeReviewState({ lastReviewedAt: '2026-09-14 12:00:00', now: NOW });
    expect(s.daysSince).toBe(3);
    expect(s.status).toBe('overdue');
    expect(s.overdueDays).toBe(2);
    expect(s.dueInDays).toBe(-2);
  });

  it('阶段越高间隔越长：stage=3（7 天）时第 3 天仍 upcoming', () => {
    const s = computeReviewState({ lastReviewedAt: '2026-09-14 12:00:00', stage: 3, now: NOW });
    expect(s.intervalDays).toBe(7);
    expect(s.daysSince).toBe(3);
    expect(s.status).toBe('upcoming');
    expect(s.dueInDays).toBe(4);
  });

  it('走完七个节点 = mastered（不再催，但天数照实算）', () => {
    const s = computeReviewState({ lastReviewedAt: '2026-09-14 12:00:00', stage: MAX_REVIEW_STAGE, now: NOW });
    expect(s.mastered).toBe(true);
    expect(s.status).toBe('mastered');
    expect(s.daysSince).toBe(3);
  });
});

describe('shared/ebbinghaus — 保持率曲线', () => {
  it('复习当天 100%，到期那天恰好 DUE_RETENTION（间隔与曲线是同一件事的两面）', () => {
    expect(retentionAt(0, 7)).toBeCloseTo(1, 5);
    expect(retentionAt(7, 7)).toBeCloseTo(DUE_RETENTION, 5);
    expect(retentionAt(14, 7)).toBeCloseTo(DUE_RETENTION * DUE_RETENTION, 5);
  });

  it('长期不复习钳在 5%（不出现 0% 这种吓人的数）', () => {
    expect(retentionAt(3650, 1)).toBeGreaterThanOrEqual(0.05);
    expect(retentionAt(3650, 1)).toBeLessThan(0.06);
  });
});

describe('shared/ebbinghaus — 阶段推进', () => {
  it('记住了进一档，封顶在毕业档', () => {
    expect(nextStage(0, true)).toBe(1);
    expect(nextStage(MAX_REVIEW_STAGE, true)).toBe(MAX_REVIEW_STAGE);
  });

  it('★ 忘了就归零（经典重来，不做「退一级」的模糊折中）', () => {
    expect(nextStage(0, false)).toBe(0);
    expect(nextStage(5, false)).toBe(0);
    expect(nextStage(MAX_REVIEW_STAGE, false)).toBe(0);
  });
});

describe('shared/ebbinghaus — UI 文案同源', () => {
  it('四条状态各有说法，且都带真实天数', () => {
    const base = { lastReviewedAt: '2026-09-14 12:00:00' };
    expect(reviewStateLabel(computeReviewState({ ...base, now: NOW }))).toContain('逾期 2 天');
    expect(reviewStateLabel(computeReviewState({ lastReviewedAt: '2026-09-16 12:00:00', now: NOW }))).toContain('今天该复习');
    expect(reviewStateLabel(computeReviewState({ lastReviewedAt: '2026-09-17 01:00:00', now: NOW }))).toContain('还有 1 天到期');
    expect(
      reviewStateLabel(computeReviewState({ ...base, stage: MAX_REVIEW_STAGE, now: NOW })),
    ).toContain('已入长期记忆');
  });
});
