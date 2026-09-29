// @vitest-environment jsdom
/**
 * drill-prefs 单测：偏好默认全开且改了就广播；当天战绩跨天归零、坏 JSON 退默认、斩过的 id 去重保留。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DRILL_OPEN_EVENT,
  DRILL_PREFS_EVENT,
  loadDrillPrefs,
  loadDrillStats,
  requestDrillOpen,
  saveDrillPrefs,
  saveDrillStats,
} from './drill-prefs';

describe('drill-prefs', () => {
  beforeEach(() => localStorage.clear());

  it('偏好：默认自动弹 + 有声；save 合并写回并广播 sb:drill-prefs', () => {
    expect(loadDrillPrefs()).toEqual({ enabled: true, sound: true });
    const spy = vi.fn();
    window.addEventListener(DRILL_PREFS_EVENT, spy);
    expect(saveDrillPrefs({ sound: false })).toEqual({ enabled: true, sound: false });
    expect(loadDrillPrefs()).toEqual({ enabled: true, sound: false });
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener(DRILL_PREFS_EVENT, spy);
  });

  it('偏好：坏 JSON / 缺字段退默认值，不抛', () => {
    localStorage.setItem('sb:drill:prefs', '{not json');
    expect(loadDrillPrefs()).toEqual({ enabled: true, sound: true });
    localStorage.setItem('sb:drill:prefs', JSON.stringify({ enabled: false }));
    expect(loadDrillPrefs()).toEqual({ enabled: false, sound: true });
  });

  it('战绩：按日历日记账，换天归零；斩过的 id 保留', () => {
    expect(loadDrillStats('2026-09-29')).toEqual({ day: '2026-09-29', slain: [], correct: 0, bestCombo: 0, reviewed: 0 });
    saveDrillStats({ day: '2026-09-29', slain: ['a', 'b'], correct: 7, bestCombo: 5, reviewed: 2 });
    expect(loadDrillStats('2026-09-29')).toEqual({ day: '2026-09-29', slain: ['a', 'b'], correct: 7, bestCombo: 5, reviewed: 2 });
    expect(loadDrillStats('2026-09-30').slain).toEqual([]);
    expect(loadDrillStats('2026-09-30').correct).toBe(0);
  });

  it('requestDrillOpen 广播 sb:drill-open', () => {
    const spy = vi.fn();
    window.addEventListener(DRILL_OPEN_EVENT, spy);
    requestDrillOpen();
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener(DRILL_OPEN_EVENT, spy);
  });
});
