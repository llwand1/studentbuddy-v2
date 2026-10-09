// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CAMPFIRE_HANDOFF_MS, useCampfireHandoff } from './useCampfireHandoff';

let reduced = false;
const listeners = new Set<() => void>();
const initial = { sessionId: null as string | null, empty: true, historyReady: true, starting: false, busy: false, failed: false };
beforeEach(() => {
  vi.useFakeTimers(); reduced = false; listeners.clear();
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('从营地首问保留原画面直至实际发送，回复可在退出期间进入；收口不延长动画，后续不重播', () => {
  const view = renderHook(props => useCampfireHandoff(props), { initialProps: initial });
  act(() => { view.result.current.begin(); view.rerender({ ...initial, starting: true }); });
  expect(view.result.current.waiting).toBe(true);
  view.rerender({ ...initial, sessionId: 'new', historyReady: false, empty: false, starting: true });
  expect(view.result.current.heroKey).toBe('campfire'); expect(view.result.current.leaving).toBe(false);
  view.rerender({ ...initial, sessionId: 'new', empty: false, busy: true });
  expect(view.result.current.leaving).toBe(true);
  act(() => vi.advanceTimersByTime(300));
  view.rerender({ ...initial, sessionId: 'new', empty: false, busy: false });
  act(() => vi.advanceTimersByTime(CAMPFIRE_HANDOFF_MS - 300));
  expect(view.result.current.keep).toBe(false);
  act(() => view.result.current.begin());
  view.rerender({ ...initial, sessionId: 'new', empty: false, busy: true });
  expect(view.result.current.leaving).toBe(false);
});

it('读取历史不触发；切会话即时撤下旧营地，迟到计时器不覆盖新会话', () => {
  const view = renderHook(props => useCampfireHandoff(props), { initialProps: initial });
  view.rerender({ ...initial, sessionId: 'history', empty: false, busy: true });
  expect(view.result.current.keep).toBe(false);
  view.rerender({ ...initial, sessionId: 'empty' });
  act(() => { view.result.current.begin(); view.rerender({ ...initial, sessionId: 'empty', empty: false, busy: true }); });
  expect(view.result.current.leaving).toBe(true);
  view.rerender({ ...initial, sessionId: 'other', empty: false });
  expect(view.result.current.keep).toBe(false);
  act(() => vi.advanceTimersByTime(2000));
  expect(view.result.current.heroKey).toBe('other'); expect(vi.getTimerCount()).toBe(0);
});

it('开会话或发送失败取消保留；重试仍可从当前空营地发起', () => {
  const view = renderHook(props => useCampfireHandoff(props), { initialProps: initial });
  act(() => { view.result.current.begin(); view.rerender({ ...initial, starting: true }); });
  view.rerender({ ...initial, failed: true });
  expect(view.result.current.keep).toBe(false);
  view.rerender(initial);
  act(() => { view.result.current.begin(); view.rerender({ ...initial, busy: true, empty: false }); });
  expect(view.result.current.leaving).toBe(true);
  view.rerender({ ...initial, empty: false, failed: true });
  expect(view.result.current.keep).toBe(false); expect(vi.getTimerCount()).toBe(0);
});

it('减少动态效果不启动，中途开启立即清理；卸载取消计时器和监听', () => {
  reduced = true;
  const view = renderHook(props => useCampfireHandoff(props), { initialProps: initial });
  act(() => view.result.current.begin()); expect(view.result.current.keep).toBe(false);
  reduced = false;
  act(() => { view.result.current.begin(); view.rerender({ ...initial, busy: true, empty: false }); });
  act(() => { reduced = true; listeners.forEach(fn => fn()); });
  expect(view.result.current.keep).toBe(false); expect(vi.getTimerCount()).toBe(0);
  reduced = false; view.rerender(initial);
  act(() => { view.result.current.begin(); view.rerender({ ...initial, busy: true, empty: false }); });
  view.unmount(); expect(vi.getTimerCount()).toBe(0); expect(listeners.size).toBe(0);
});
