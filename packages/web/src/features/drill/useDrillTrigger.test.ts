// @vitest-environment jsdom
/**
 * useDrillTrigger 单测（契约 docs/WAIT-DRILL-SPEC.md §2）：
 * 2 秒还没回完才弹 / 秒回不弹 / 回复到了置 replyReady / 手动关掉本轮不再弹、下一轮照弹 /
 * 不在对话页或设置关掉不弹 / 手动打开不受表约束。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDrillTrigger } from './useDrillTrigger';

type Props = { busySessionId: string | null; active: boolean; enabled: boolean };

function mount(initial: Props) {
  return renderHook((p: Props) => useDrillTrigger({ ...p, delayMs: 2000 }), { initialProps: initial });
}

describe('useDrillTrigger', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('发送后 2 秒还在生成 ⇒ 弹，并记下正在等的会话；回复到了 ⇒ replyReady', () => {
    const h = mount({ busySessionId: 's1', active: true, enabled: true });
    expect(h.result.current.open).toBe(false);
    act(() => vi.advanceTimersByTime(1999));
    expect(h.result.current.open).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(h.result.current.open).toBe(true);
    expect(h.result.current.openSession).toBe('s1');
    expect(h.result.current.replyReady).toBe(false);
    h.rerender({ busySessionId: null, active: true, enabled: true });
    expect(h.result.current.open).toBe(true);
    expect(h.result.current.replyReady).toBe(true);
  });

  it('秒回（2 秒内结束）什么都不弹', () => {
    const h = mount({ busySessionId: 's1', active: true, enabled: true });
    act(() => vi.advanceTimersByTime(800));
    h.rerender({ busySessionId: null, active: true, enabled: true });
    act(() => vi.advanceTimersByTime(5000));
    expect(h.result.current.open).toBe(false);
    expect(h.result.current.replyReady).toBe(false);
  });

  it('倒计时期间离开对话、进入专注或关掉开关，不得按旧许可弹出；手动入口仍可用', () => {
    const h = mount({ busySessionId: 's1', active: true, enabled: true });
    act(() => vi.advanceTimersByTime(1000));
    h.rerender({ busySessionId: 's1', active: false, enabled: true });
    act(() => vi.advanceTimersByTime(2000));
    expect(h.result.current.open).toBe(false);
    act(() => h.result.current.openNow());
    expect(h.result.current.open).toBe(true);
    act(() => h.result.current.close());
    h.rerender({ busySessionId: 's2', active: true, enabled: true });
    h.rerender({ busySessionId: 's2', active: true, enabled: false });
    act(() => vi.advanceTimersByTime(3000));
    expect(h.result.current.open).toBe(false);
  });

  it('手动关掉：本轮不再弹（哪怕还在生成很久）；下一轮照弹', () => {
    const h = mount({ busySessionId: 's1', active: true, enabled: true });
    act(() => vi.advanceTimersByTime(2000));
    expect(h.result.current.open).toBe(true);
    act(() => h.result.current.close());
    expect(h.result.current.open).toBe(false);
    act(() => vi.advanceTimersByTime(60_000));
    expect(h.result.current.open).toBe(false);
    h.rerender({ busySessionId: null, active: true, enabled: true });
    h.rerender({ busySessionId: 's2', active: true, enabled: true });
    act(() => vi.advanceTimersByTime(2000));
    expect(h.result.current.open).toBe(true);
    expect(h.result.current.openSession).toBe('s2');
  });

  it('不在对话页 / 设置关掉 ⇒ 不自动弹；但 openNow 照开（练习局不设 replyReady）', () => {
    const a = mount({ busySessionId: 's1', active: false, enabled: true });
    act(() => vi.advanceTimersByTime(3000));
    expect(a.result.current.open).toBe(false);
    const b = mount({ busySessionId: 's1', active: true, enabled: false });
    act(() => vi.advanceTimersByTime(3000));
    expect(b.result.current.open).toBe(false);
    act(() => b.result.current.openNow());
    expect(b.result.current.open).toBe(true);
    expect(b.result.current.openSession).toBe('s1');
    expect(b.result.current.replyReady).toBe(false);
    const c = mount({ busySessionId: null, active: true, enabled: true });
    act(() => c.result.current.openNow());
    expect(c.result.current.open).toBe(true);
    expect(c.result.current.replyReady).toBe(false);
  });

  it('唤回（没在等回复时 openNow）沿用上一次的 openSession——换了会话 id 等于换话题，会再要一批新词', () => {
    const h = mount({ busySessionId: 's1', active: true, enabled: true });
    act(() => vi.advanceTimersByTime(2000));
    expect(h.result.current.openSession).toBe('s1');
    act(() => h.result.current.close());
    h.rerender({ busySessionId: null, active: true, enabled: true });
    act(() => h.result.current.openNow());
    expect(h.result.current.open).toBe(true);
    expect(h.result.current.openSession).toBe('s1');
    act(() => h.result.current.close());
    h.rerender({ busySessionId: 's3', active: true, enabled: true });
    act(() => h.result.current.openNow());
    expect(h.result.current.openSession).toBe('s3');
  });
});
