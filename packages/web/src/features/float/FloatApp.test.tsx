// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DesktopStudyState } from '@sb/shared';
import { StudyClock } from '../../../../server/src/desktop/study-clock';
const host = vi.hoisted(() => ({ handlers: [] as Array<(event: { data: string }) => void>, sent: [] as string[] }));
const server = vi.hoisted(() => ({ clock: null as StudyClock | null }));
vi.mock('../../app/App', () => ({ App: () => <div>APP_MUST_NOT_OPEN</div> }));
vi.mock('../desktop/desktop-api', () => ({ desktopApi: {
  tick: async (eligible: boolean) => server.clock!.tick(eligible),
  dismiss: async (action: 'done' | 'skip' | 'snooze') => { server.clock!.dismiss(action); return server.clock!.state(); },
  settings: async (settings: DesktopStudyState['settings']) => { server.clock!.configure(settings); return server.clock!.state(); },
} }));
const { FloatApp } = await import('./FloatApp');
afterEach(() => { cleanup(); vi.useRealTimers(); delete (window as unknown as { chrome?: unknown }).chrome; host.handlers = []; host.sent = []; });
it('native background ticks deliver a timed question without mounting App, then return to the mascot after answering', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-11T05:00:00Z'));
  (window as unknown as { chrome: unknown }).chrome = { webview: {
    postMessage: (value: string) => host.sent.push(value),
    addEventListener: (_type: string, fn: (event: { data: string }) => void) => host.handlers.push(fn),
    removeEventListener: (_type: string, fn: (event: { data: string }) => void) => { host.handlers = host.handlers.filter(h => h !== fn); },
  } };
  server.clock = new StudyClock({ enabled: true, intervalMinutes: 3, scope: 'learning' }, async () => ({
    id: 'q1', scope: '', question: { topic: '数学', question: '2 加 3 是多少？', options: ['4', '5'], answer: 1, explanation: '2 加 3 等于 5。' },
  }), () => 'learning');
  await act(async () => { render(<FloatApp />); });
  expect(document.documentElement.dataset.float).toBe('ball');
  vi.setSystemTime(new Date('2026-10-11T05:03:00Z'));
  await act(async () => { host.handlers.forEach(fn => fn({ data: 'sb-float:tick' })); });
  expect(screen.queryByText('APP_MUST_NOT_OPEN')).toBeNull(); expect(screen.getByText('2 加 3 是多少？')).toBeTruthy();
  expect(host.sent).toContain('sb-float:quiz');
  fireEvent.click(screen.getByRole('button', { name: /B\s*5/ }));
  expect(screen.getByText('答对了 · 火花点亮！')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /完成/ })); });
  expect(document.documentElement.dataset.float).toBe('ball'); expect(host.sent.at(-1)).toBe('sb-float:collapse');
  expect(server.clock.state().nextAt).toBe(Date.now() + 180000);
});
