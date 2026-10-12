// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FloatCompanion } from './FloatCompanion';
import { HOST_SHAPE } from './companion-view';
import { HOST_TAP, HOST_MOTION_START, HOST_MOTION_END, HOST_EFFECTS_OFF } from './float-view';
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
  fireEvent.pointerOver(ball); fireEvent.pointerMove(ball, { clientX: -10 });
  const eyeRects = () => Array.from(ball.querySelectorAll('g[transform] rect.px-ink')).slice(-4);
  expect(eyeRects().every(r => r.getAttribute('height') === '0.5')).toBe(true);
  const left = eyeRects().map(r => r.getAttribute('x'));
  fireEvent.pointerMove(ball, { clientX: 10 });
  expect(eyeRects().map(r => r.getAttribute('x'))).not.toEqual(left);
  fireEvent.pointerDown(ball, { button: 0, shiftKey: true });
  fireEvent.click(ball, { shiftKey: true, detail: 1 });
  expect(ball.dataset.mood).toBe('play');
  expect(open).not.toHaveBeenCalled(); expect(sent).not.toContain('sb-float:drag');
  await act(async () => { vi.advanceTimersByTime(2201); });
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
  expect(sent).toContain(HOST_EFFECTS_OFF);
  await act(async () => { vi.advanceTimersByTime(1000); }); expect(sent.length).toBe(before);
  fireEvent.wheel(screen.getByRole('button')); expect(screen.getByRole('button').dataset.mood).toBe('play');
  expect(screen.getByRole('button').querySelector('svg')?.dataset.school).toBe('hex');
  fireEvent.wheel(screen.getByRole('button'));
  expect(screen.getByRole('button').querySelector('svg')?.dataset.school).toBe('rift');
  expect(open).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(2201); }); expect(screen.getByRole('button').dataset.mood).toBe('focus');
});
it('native movement stays with fire through the drag and drop burst without opening App', async () => {
  vi.useFakeTimers(); nativeHost();
  const open = vi.fn(); render(<FloatCompanion mood="reading" onOpen={open} onSettings={() => {}} />);
  act(() => inbox?.({ data: HOST_MOTION_START }));
  expect(screen.getByRole('button').dataset.mood).toBe('dragging');
  expect(screen.getByRole('button').querySelector('svg')?.dataset.school).toBe('ember');
  await act(async () => { vi.advanceTimersByTime(5000); });
  expect(screen.getByRole('button').dataset.mood).toBe('dragging');
  act(() => inbox?.({ data: HOST_MOTION_END }));
  expect(screen.getByRole('button').dataset.mood).toBe('play');
  expect(screen.getByRole('button').querySelector('svg')?.dataset.school).toBe('ember');
  await act(async () => { vi.advanceTimersByTime(2201); });
  expect(screen.getByRole('button').dataset.mood).toBe('reading');
  expect(open).not.toHaveBeenCalled();
});

