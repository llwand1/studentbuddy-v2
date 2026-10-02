// @vitest-environment jsdom
/**
 * PomodoroPanel：督促抽屉顶部的专注区（契约 `docs/POMODORO-SPEC.md` §3 / §10）。REST 替身，锁四条：
 *  ① 没 loaded 不拉统计；loaded 后拉一次，表头写「今日 N 轮 · M 分」；
 *  ② 一轮没专注过：不画图、给引导语；有记录：折线 svg 在、按方向芯片在（分钟来自服务端，前端不累加）；
 *  ③ 会话 completed 变了（刚完成一轮）⇒ 重拉统计；
 *  ④ 开钟卡在面板里（搬家后的落点）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { nextPomodoroPhase, startPomodoro, type PomodoroSession, type PomodoroStats } from '@sb/shared';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), clear: vi.fn(), stats: vi.fn() }));
vi.mock('../../lib/api-pomodoro', () => ({ pomodoroApi: api }));
vi.mock('../../lib/api', () => ({ api: { terms: { domains: vi.fn().mockResolvedValue({ domains: [] }) } } }));

const store = await import('./pomodoro-store');
const { PomodoroPanel } = await import('./PomodoroPanel');

const T0 = new Date('2026-10-01T08:00:00Z');
const days = (n: number) => Array.from({ length: 7 }, (_, i) => ({ day: `2026-09-${25 + i}`, rounds: i === 6 ? n : 0, minutes: i === 6 ? n * 25 : 0 }));
const EMPTY: PomodoroStats = { today: { rounds: 0, minutes: 0 }, recent: days(0), bySubject: [] };
const SOME: PomodoroStats = { today: { rounds: 2, minutes: 50 }, recent: days(2), bySubject: [{ subject: '数学', rounds: 2, minutes: 50 }] };
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  store.resetPomodoroStore();
  api.get.mockReset();
  api.put.mockReset();
  api.stats.mockReset();
  api.put.mockImplementation(async (s: PomodoroSession) => ({ session: s, focus: null }));
});
afterEach(() => cleanup());

describe('PomodoroPanel', () => {
  it('① ② 未 loaded 不拉；loaded 后拉一次；空统计给引导语、不画图；有统计给表头 / 折线 / 方向芯片', async () => {
    api.stats.mockResolvedValue(EMPTY);
    render(<PomodoroPanel />);
    await flush();
    expect(api.stats).not.toHaveBeenCalled();
    api.get.mockResolvedValue({ session: null, focus: null });
    await act(async () => {
      await store.loadPomodoroState();
    });
    await flush();
    expect(api.stats).toHaveBeenCalledTimes(1);
    expect(screen.getByText('定下方向，功能跟着你走')).toBeTruthy();
    expect(screen.getByText(/完成第一轮后/)).toBeTruthy();
    expect(document.querySelector('.pomo-chart')).toBeNull();
    // ④ 开钟卡在面板里
    expect(screen.getByTestId('pomodoro-panel').querySelector('[data-testid="pomodoro-card"]')).toBeTruthy();
    cleanup();
    api.stats.mockResolvedValue(SOME);
    render(<PomodoroPanel />);
    await flush();
    expect(screen.getByText('今日 2 轮 · 50 分')).toBeTruthy();
    expect(document.querySelector('.pomo-chart svg')).toBeTruthy();
    expect(screen.getByText('数学').closest('.pomo-chip')?.textContent).toContain('50 分');
    expect(screen.getByText(/共 2 轮/)).toBeTruthy();
  });

  it('③ 翻段（completed 变）⇒ 重拉统计；同一会话原样不重拉', async () => {
    api.stats.mockResolvedValue(EMPTY);
    const s = startPomodoro({ subject: '数学', workMin: 25 }, T0)!;
    api.get.mockResolvedValue({ session: s, focus: null });
    render(<PomodoroPanel />);
    await act(async () => {
      await store.loadPomodoroState();
    });
    await flush();
    expect(api.stats).toHaveBeenCalledTimes(1);
    api.stats.mockResolvedValue(SOME);
    await act(async () => {
      await store.advanceFocus(new Date(T0.getTime() + 25 * 60_000));
    });
    await flush();
    expect(api.stats).toHaveBeenCalledTimes(2);
    expect(screen.getByText('今日 2 轮 · 50 分')).toBeTruthy();
    // 休息 → 下一轮工作：completed 不变 ⇒ 不重拉
    await act(async () => {
      await store.advanceFocus(new Date(T0.getTime() + 30 * 60_000));
    });
    await flush();
    expect(api.stats).toHaveBeenCalledTimes(2);
    expect(nextPomodoroPhase(s, T0).completed).toBe(1);
  });
});
