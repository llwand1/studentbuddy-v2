// @vitest-environment jsdom
/**
 * WaitDrill 页面测试 ③——「收起 ≠ 结束，能唤回」（契约 docs/WAIT-DRILL-SPEC.md §2.1，2026-09-30）：
 *  - ✕ / Esc / 回复到了自动切回 ⇒ 小窗收起、`drill-dock` 标 parked（还有 N 张 / 连击）；`requestDrillOpen` ⇒ **同一局**原样回来
 *    （同一张卡、战绩不清、词库只取过一次）；下一轮等待自动弹的也是这同一局；
 *  - 小签 ✕（`requestDrillEnd`）才结束：parked 清掉，再开就是新一局（词库重取、战绩归零）。
 *  - `DrillParkedPill` 只在 parked 时渲染，点签发 `sb:drill-open`、✕ 发 `sb:drill-end`。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react';
import { clickCorrect, dialog, flush, mapMock, markMock, newTermsMock, keepMock, dismissMock, prompt, resetDrillMocks } from './WaitDrill.testkit';
import { DRILL_OPEN_EVENT, requestDrillOpen } from './drill-prefs';
import { DRILL_END_EVENT, readDrillDock, requestDrillEnd, setDrillDock } from './drill-dock';
import { DrillParkedPill } from './DrillParkedPill';

vi.mock('../../lib/api-terms-continent', () => ({ termsContinentApi: { map: mapMock } }));
vi.mock('../../lib/api-terms-review', () => ({ termsReviewApi: { mark: markMock } }));
vi.mock('../../lib/api-drill', () => ({ drillApi: { newTerms: newTermsMock, keep: keepMock, dismiss: dismissMock } }));

const { WaitDrill, READY_GRACE_S } = await import('./WaitDrill');

async function openBusy(sid = 's1') {
  const view = render(<WaitDrill busySessionId={sid} active />);
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  await flush();
  return view;
}

const stats = () => document.querySelector('.drill-stats')?.textContent ?? '';

describe('WaitDrill：收起与唤回', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetDrillMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('★ Esc 收起 ⇒ dock 标 parked；requestDrillOpen ⇒ 同一张卡、战绩还在、拼写草稿还在、词库不重取', async () => {
    await openBusy();
    for (let i = 0; i < 3; i += 1) {
      clickCorrect();
      await act(async () => {
        vi.advanceTimersByTime(800);
      });
    }
    expect(stats()).toContain('答对 3');
    // 第 4 张是拼写卡：打一半再收起
    const input = screen.getByLabelText('拼写作答') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '闭' } });
    expect(document.querySelectorAll('.drill-spell .ti-cell.filled')).toHaveLength(1);
    const asked = prompt();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog()).toBeNull();
    const dock = readDrillDock();
    expect(dock.parked).toBe(true);
    expect(dock.correct).toBe(3);
    expect(dock.queueLeft).toBeGreaterThan(0);

    act(() => requestDrillOpen());
    await flush();
    expect(dialog()).not.toBeNull();
    expect(prompt()).toBe(asked);
    expect(stats()).toContain('答对 3');
    expect(document.querySelectorAll('.drill-spell .ti-cell.filled')).toHaveLength(1);
    expect(mapMock).toHaveBeenCalledTimes(1);
    expect(readDrillDock().parked).toBe(false);
  });

  it('回复到了自动切回也是收起；下一轮等待自动弹的是同一局；小签 ✕ 才结束，再开是新一局', async () => {
    const view = await openBusy();
    clickCorrect();
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    view.rerender(<WaitDrill busySessionId={null} active />);
    await act(async () => {
      vi.advanceTimersByTime(READY_GRACE_S * 1000 + 500);
    });
    expect(dialog()).toBeNull();
    expect(readDrillDock().parked).toBe(true);

    view.rerender(<WaitDrill busySessionId="s2" active />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    await flush();
    expect(dialog()).not.toBeNull();
    expect(stats()).toContain('答对 1');
    expect(mapMock).toHaveBeenCalledTimes(1);
    // 换了正在等的会话 ⇒ 只是再要一批新词插进队列（新词跟着话题走），不重开局
    expect(newTermsMock).toHaveBeenCalledTimes(2);
    expect(newTermsMock).toHaveBeenLastCalledWith('s2');

    act(() => requestDrillEnd());
    expect(dialog()).toBeNull();
    expect(readDrillDock().parked).toBe(false);
    act(() => requestDrillOpen());
    await flush();
    expect(dialog()).not.toBeNull();
    expect(mapMock).toHaveBeenCalledTimes(2);
    expect(stats()).toContain('答对 0');
  });

  it('DrillParkedPill：parked 才渲染，写清还有几张与连击；点签发 sb:drill-open，✕ 发 sb:drill-end', () => {
    const opened = vi.fn();
    const ended = vi.fn();
    window.addEventListener(DRILL_OPEN_EVENT, opened);
    window.addEventListener(DRILL_END_EVENT, ended);
    const view = render(<DrillParkedPill />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => setDrillDock({ parked: true, queueLeft: 7, correct: 3, combo: 3 }));
    expect(screen.getByRole('status').textContent).toContain('刷词已收起 · 还有 7 张');
    expect(screen.getByRole('status').textContent).toContain('连击 3');
    fireEvent.click(screen.getByTitle(/唤回刷词小窗/));
    expect(opened).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('结束这一局'));
    expect(ended).toHaveBeenCalledTimes(1);
    act(() => setDrillDock({ parked: false, queueLeft: 0, correct: 0, combo: 0 }));
    expect(screen.queryByRole('status')).toBeNull();
    view.unmount();
    window.removeEventListener(DRILL_OPEN_EVENT, opened);
    window.removeEventListener(DRILL_END_EVENT, ended);
  });
});
