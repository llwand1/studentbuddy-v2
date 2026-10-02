// @vitest-environment jsdom
/**
 * PomodoroCard：复习列表里的开钟卡（契约 `docs/POMODORO-SPEC.md` §3）。REST 替身，锁四条：
 *  ① 未开钟：方向为空时「开始专注」禁用；领域芯片点一下填进方向；时长档位选中态跟着输入走；
 *  ② 开始 ⇒ PUT 一份 shared 算出的会话（phase work、workMin 对、结束 = 开始 + 时长）；
 *  ③ 开着钟：显示方向、轮次、倒计时跳动；到点显示「到点了」但 phase 仍 work（不自动翻页）；
 *  ④ 工作段三个键 / 休息段两个键各打对应写口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { nextPomodoroPhase, startPomodoro, type PomodoroSession } from '@sb/shared';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), clear: vi.fn() }));
vi.mock('../../lib/api-pomodoro', () => ({ pomodoroApi: api }));
const terms = vi.hoisted(() => ({ domains: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { terms: { domains: terms.domains } } }));

const store = await import('./pomodoro-store');
const { PomodoroCard } = await import('./PomodoroCard');

const T0 = new Date('2026-10-01T08:00:00Z');
const load = async (session: PomodoroSession | null): Promise<void> => {
  api.get.mockResolvedValue({ session, focus: null });
  await act(async () => {
    await store.loadPomodoroState();
  });
};
const show = async () => {
  const r = render(<PomodoroCard />);
  await act(async () => {
    await Promise.resolve();
  });
  return r;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store.resetPomodoroStore();
  api.get.mockReset();
  api.put.mockReset();
  api.clear.mockReset();
  api.put.mockImplementation(async (s: PomodoroSession) => ({ session: s, focus: null }));
  api.clear.mockResolvedValue({ session: null, focus: null });
  terms.domains.mockResolvedValue({ domains: [{ domain: '数学', count: 3 }, { domain: 'js', count: 2 }] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('① ② 未开钟', () => {
  it('方向为空禁用；点领域芯片填方向；选 45 分钟；开始 ⇒ PUT 一份算好的会话', async () => {
    await load(null);
    await show();
    const start = screen.getByRole('button', { name: '开始专注' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '数学' }));
    });
    expect((screen.getByLabelText('学习方向') as HTMLInputElement).value).toBe('数学');
    expect(start.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '45' }));
    });
    expect((screen.getByLabelText('工作时长（分钟）') as HTMLInputElement).value).toBe('45');
    expect(screen.getByRole('button', { name: '45' }).className).toContain('on');
    await act(async () => {
      fireEvent.click(start);
    });
    expect(api.put).toHaveBeenCalledTimes(1);
    const s = api.put.mock.calls[0]?.[0] as PomodoroSession;
    expect(s.subject).toBe('数学');
    expect(s.workMin).toBe(45);
    expect(s.phase).toBe('work');
    expect(Date.parse(s.phaseEndsAt) - Date.parse(s.phaseStartedAt)).toBe(45 * 60_000);
    // 开钟后卡片切到运行态
    expect(screen.getByText('🍅 数学')).toBeTruthy();
  });

  it('自己敲的时长超界按 shared 钳位（9999 ⇒ 180）', async () => {
    await load(null);
    await show();
    fireEvent.change(screen.getByLabelText('学习方向'), { target: { value: '物理' } });
    fireEvent.change(screen.getByLabelText('工作时长（分钟）'), { target: { value: '9999' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始专注' }));
    });
    expect((api.put.mock.calls[0]?.[0] as PomodoroSession).workMin).toBe(180);
  });
});

describe('③ ④ 开着钟', () => {
  it('倒计时每秒走；到点显示「到点了」且不自动翻页；「提前休息」变「开始休息」', async () => {
    await load(startPomodoro({ subject: '数学', workMin: 25 }, T0));
    await show();
    expect(screen.getByRole('timer').textContent).toBe('25:00');
    expect(screen.getByText(/第 1 轮 · 已完成 0 轮/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '提前休息' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.getByRole('timer').textContent).toBe('23:59');
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + 25 * 60_000));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole('timer').textContent).toContain('00:00');
    expect(screen.getByText('到点了')).toBeTruthy();
    expect(store.readPomodoro().session?.phase).toBe('work');
    expect(api.put).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始休息' }));
    });
    expect((api.put.mock.calls[0]?.[0] as PomodoroSession).phase).toBe('break');
    expect(screen.getByText('☕ 休息中')).toBeTruthy();
  });

  it('休息段：「开始第 2 轮」⇒ 工作 round 2；「结束番茄钟」⇒ DELETE 并回到开钟表单', async () => {
    const b = nextPomodoroPhase(startPomodoro({ subject: '数学', workMin: 25 }, T0)!, T0);
    await load(b);
    await show();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始第 2 轮' }));
    });
    expect((api.put.mock.calls[0]?.[0] as PomodoroSession).round).toBe(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '结束番茄钟' }));
    });
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '开始专注' })).toBeTruthy();
  });
});
