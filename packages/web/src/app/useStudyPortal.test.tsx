// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStudyPortal } from './useStudyPortal';

let reduce = false;
const listeners = new Set<() => void>();
beforeEach(() => {
  vi.useFakeTimers(); reduce = false; listeners.clear();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduce; },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const origin = { x: 1200, y: 280 };

it('遮幕闭合后只跳一次；连点不叠加，普通导航取消待执行传送', () => {
  const apply = vi.fn(); const h = renderHook(() => useStudyPortal(apply));
  act(() => { h.result.current.enter('terms', origin); h.result.current.enter('continent', origin); });
  expect(h.result.current.travel?.destination).toBe('terms');
  act(() => { vi.advanceTimersByTime(339); }); expect(apply).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); }); expect(apply.mock.calls).toEqual([['terms']]);
  act(() => { vi.advanceTimersByTime(520); }); expect(h.result.current.travel).toBeNull();
  act(() => { h.result.current.enter('continent', origin); h.result.current.navigate('settings'); vi.advanceTimersByTime(1000); });
  expect(apply.mock.calls).toEqual([['terms'], ['settings']]);
});

it('减少动态效果直接到达，中途切换即时收尾；卸载不触发迟到跳页', () => {
  const apply = vi.fn(); reduce = true; const h = renderHook(() => useStudyPortal(apply));
  act(() => { h.result.current.enter('terms', origin); });
  expect(apply.mock.calls).toEqual([['terms']]); expect(h.result.current.travel).toBeNull();
  act(() => { reduce = false; h.result.current.enter('continent', origin); });
  act(() => { reduce = true; listeners.forEach(fn => fn()); vi.advanceTimersByTime(1000); });
  expect(apply.mock.calls).toEqual([['terms'], ['continent']]); expect(h.result.current.travel).toBeNull();
  act(() => { reduce = false; h.result.current.enter('terms', origin); });
  h.unmount(); act(() => { vi.advanceTimersByTime(1000); });
  expect(apply).toHaveBeenCalledTimes(2); expect(listeners.size).toBe(0);
});
