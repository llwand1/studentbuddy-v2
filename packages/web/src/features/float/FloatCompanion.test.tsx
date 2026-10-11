// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FloatCompanion } from './FloatCompanion';
import { HOST_SHAPE } from './companion-view';
import { HOST_TAP } from './float-view';
let inbox: ((event: { data: string }) => void) | null = null;
const sent: string[] = [];
function nativeHost() {
  (window as unknown as { chrome: unknown }).chrome = { webview: {
    postMessage: (message: string) => sent.push(message),
    addEventListener: (_type: string, handler: (e: { data: string }) => void) => { inbox = handler; },
    removeEventListener: () => { inbox = null; },
  } };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (window as unknown as { chrome?: unknown }).chrome; sent.length = 0; inbox = null; });
it('pet gestures cast particles without dragging or opening; native taps and keyboard activation still open', async () => {
  vi.useFakeTimers(); nativeHost(); vi.stubGlobal('PointerEvent', MouseEvent);
  const open = vi.fn(); const settings = vi.fn();
  render(<FloatCompanion mood="reading" onOpen={open} onSettings={settings} />);
  const ball = screen.getByRole('button');
  expect(sent.some(m => m.startsWith(HOST_SHAPE))).toBe(true);
  fireEvent.pointerDown(ball, { button: 0, shiftKey: true });
  fireEvent.click(ball, { shiftKey: true, detail: 1 });
  expect(ball.dataset.mood).toBe('play');
  expect(open).not.toHaveBeenCalled(); expect(sent).not.toContain('sb-float:drag');
  await act(async () => { vi.advanceTimersByTime(1801); });
  expect(ball.dataset.mood).toBe('reading');
  fireEvent.pointerDown(ball, { button: 0 }); expect(sent).toContain('sb-float:drag');
  fireEvent.click(ball, { detail: 1 }); expect(open).not.toHaveBeenCalled();
  act(() => inbox?.({ data: HOST_TAP })); expect(open).toHaveBeenCalledTimes(1);
  fireEvent.click(ball, { detail: 0 }); expect(open).toHaveBeenCalledTimes(2);
  fireEvent.contextMenu(ball); expect(settings).toHaveBeenCalledTimes(1);
});
it('wheel interaction is temporary and never opens App; reduced motion supplies one static native frame', async () => {
  vi.useFakeTimers(); nativeHost();
  const listeners: Array<() => void> = [];
  const media = { matches: true, addEventListener: (_: string, fn: () => void) => listeners.push(fn), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => media);
  const open = vi.fn(); render(<FloatCompanion mood="focus" onOpen={open} onSettings={() => {}} />);
  const before = sent.length;
  await act(async () => { vi.advanceTimersByTime(1000); }); expect(sent.length).toBe(before);
  fireEvent.wheel(screen.getByRole('button')); expect(screen.getByRole('button').dataset.mood).toBe('play');
  expect(open).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1801); }); expect(screen.getByRole('button').dataset.mood).toBe('focus');
});

