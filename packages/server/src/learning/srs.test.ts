import { describe, it, expect } from 'vitest';
import { schedule, nextReviewAt, isDue, type SrsState } from './srs.js';

/** SRS 引擎单测：fake 时间用注入 Date（纯函数天然可测，无需 timers 快进） */
const S = (ease = 2.5, interval = 0, review = 0, lapse = 0): SrsState => ({
  easeFactor: ease,
  intervalDays: interval,
  reviewCount: review,
  lapseCount: lapse,
});

describe('learning/srs — SM-2 调度引擎（演进④核心，fake 时间断言）', () => {
  it('首次记住：interval 1 天，ease 按公式变化', () => {
    const out = schedule(S(), 4);
    expect(out.intervalDays).toBe(1);
    expect(out.reviewCount).toBe(1);
    // EF' = 2.5 + (0.1 - 1*(0.08+0.02)) = 2.5
    expect(out.easeFactor).toBeCloseTo(2.5, 5);
  });

  it('第二次记住：interval 3 天；之后 interval × ease 递增', () => {
    let st = schedule(S(), 4); // →1
    st = schedule(st, 4); // →3
    expect(st.intervalDays).toBe(3);
    st = schedule(st, 4); // → round(3*2.5)=8? ease 仍 2.5
    expect(st.intervalDays).toBeGreaterThanOrEqual(7);
  });

  it('没记住（q<3）：interval 重置 1 天、lapse+1、reviewCount 归零', () => {
    const out = schedule(S(2.5, 21, 5, 0), 1);
    expect(out.intervalDays).toBe(1);
    expect(out.reviewCount).toBe(0);
    expect(out.lapseCount).toBe(1);
    // EF' = 2.5 + (0.1 - 4*(0.08+4*0.02)) = 2.5 - 0.54 = 1.96
    expect(out.easeFactor).toBeCloseTo(1.96, 5);
  });

  it('ease 下限 1.3（连续遗忘不塌穿）', () => {
    let st = S(1.35, 0, 0, 0);
    for (let i = 0; i < 10; i++) st = schedule(st, 1);
    expect(st.easeFactor).toBeGreaterThanOrEqual(1.3);
  });

  it('nextReviewAt / isDue 时间推算正确（快进 3 天后天数差正确）', () => {
    const now = new Date('2026-08-23T10:00:00Z');
    const nra = nextReviewAt(now, 3);
    expect(new Date(nra).getTime() - now.getTime()).toBe(3 * 86_400_000);
    expect(isDue(nra, new Date('2026-08-25T10:00:00Z'))).toBe(false);
    expect(isDue(nra, new Date('2026-08-26T10:00:01Z'))).toBe(true);
    expect(isDue(null, now)).toBe(true); // 新词立即到期
  });
});
