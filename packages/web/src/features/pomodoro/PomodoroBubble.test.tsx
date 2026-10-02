// @vitest-environment jsdom
/**
 * PomodoroBubble：督促胶囊旁的番茄提醒（契约 `docs/POMODORO-SPEC.md` §7）。store 直接灌、REST 替身。
 * 锁五条：
 *  ① 没 loaded 不渲染；工作段进行中不渲染；到点 ⇒ work-done 三个键（休息 / 再来一轮 / 结束）各打对应写口；
 *  ② 休息到点 ⇒ break-done；
 *  ③ 没开钟：打开未满 3 分钟不提；满了提 setup，「去定一个」发 `sb:pomodoro-open` 并记本机时间戳；
 *  ④ ✕ 收起只针对这一次：同一段不再冒，翻到下一段到点再冒；
 *  ⑤ setup 的 ✕ 记时间戳 ⇒ 2 小时内不再提。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { POMODORO_SETUP_NUDGE_DELAY_MS, startPomodoro, nextPomodoroPhase, type PomodoroSession } from '@sb/shared';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), clear: vi.fn() }));
vi.mock('../../lib/api-pomodoro', () => ({ pomodoroApi: api }));

const store = await import('./pomodoro-store');
const { PomodoroBubble } = await import('./PomodoroBubble');

const T0 = new Date('2026-10-01T08:00:00Z');
const bubble = (): HTMLElement | null => screen.queryByTestId('pomodoro-bubble');
const load = async (session: PomodoroSession | null): Promise<void> => {
  api.get.mockResolvedValue({ session, focus: null });
  await act(async () => {
    await store.loadPomodoroState();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  localStorage.clear();
  store.resetPomodoroStore();
  api.get.mockReset();
  api.put.mockReset();
  api.clear.mockReset();
  api.put.mockImplementation(async (s: PomodoroSession) => ({ session: s, focus: null }));
  api.clear.mockResolvedValue({ session: null, focus: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('① ② 到点提醒', () => {
  it('未 loaded / 进行中不渲染；工作段到点 ⇒ work-done，三个键各走各的写口', async () => {
    render(<PomodoroBubble openedAt={T0} />);
    expect(bubble()).toBeNull();
    await load(startPomodoro({ subject: '数学', workMin: 25 }, T0));
    expect(bubble()).toBeNull();
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + 25 * 60_000));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(bubble()?.textContent).toContain('「数学」第 1 轮 25 分钟到了');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始休息' }));
    });
    expect(api.put).toHaveBeenCalledTimes(1);
    expect((api.put.mock.calls[0]?.[0] as PomodoroSession).phase).toBe('break');
    expect(bubble()).toBeNull(); // 翻段后休息刚开始，不冒
  });

  it('休息到点 ⇒ break-done；「开始下一轮」⇒ 第 2 轮工作；「结束」⇒ DELETE', async () => {
    const b = nextPomodoroPhase(startPomodoro({ subject: '数学', workMin: 25, breakMin: 5 }, T0)!, T0);
    render(<PomodoroBubble openedAt={T0} />);
    await load(b);
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + 5 * 60_000));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(bubble()?.textContent).toContain('休息结束，继续「数学」第 2 轮');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始下一轮' }));
    });
    expect((api.put.mock.calls[0]?.[0] as PomodoroSession).round).toBe(2);
    // 下一轮到点再冒，点「结束」
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + 31 * 60_000));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(bubble()?.textContent).toContain('第 2 轮');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '结束' }));
    });
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(store.readPomodoro().session).toBeNull();
  });

  it('再来一轮：跳过休息直接第 2 轮工作（这一轮算完成）', async () => {
    render(<PomodoroBubble openedAt={T0} />);
    await load(startPomodoro({ subject: '数学', workMin: 25 }, T0));
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + 25 * 60_000));
      await vi.advanceTimersByTimeAsync(1000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '再来一轮' }));
    });
    const s = api.put.mock.calls[0]?.[0] as PomodoroSession;
    expect(s.phase).toBe('work');
    expect(s.round).toBe(2);
    expect(s.completed).toBe(1);
  });
});

describe('③ ⑤ 没开钟的 setup 提醒', () => {
  it('未满 3 分钟不提；满了提；「去定一个」发事件并记时间戳；之后 2 小时内不再提', async () => {
    const opened = vi.fn();
    window.addEventListener(store.POMODORO_OPEN_EVENT, opened);
    render(<PomodoroBubble openedAt={T0} />);
    await load(null);
    expect(bubble()).toBeNull();
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + POMODORO_SETUP_NUDGE_DELAY_MS));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(bubble()?.textContent).toContain('还没定番茄钟');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '去定一个' }));
    });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(store.readSetupNudgeAt()).not.toBeNull();
    expect(bubble()).toBeNull();
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + 60 * 60_000));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(bubble()).toBeNull();
  });

  it('setup 的 ✕ 也记时间戳（先不了 = 2 小时内别提）', async () => {
    render(<PomodoroBubble openedAt={T0} />);
    await load(null);
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + POMODORO_SETUP_NUDGE_DELAY_MS + 1000));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(bubble()).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTitle('先不了（2 小时内不再提）'));
    });
    expect(bubble()).toBeNull();
    expect(store.readSetupNudgeAt()).not.toBeNull();
  });
});

describe('④ 收起只针对这一次', () => {
  it('工作段到点 ✕ 后不再冒；翻到休息、休息到点再冒', async () => {
    render(<PomodoroBubble openedAt={T0} />);
    const s = startPomodoro({ subject: '数学', workMin: 25, breakMin: 5 }, T0)!;
    await load(s);
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + 25 * 60_000));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(bubble()).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTitle('先收起'));
    });
    expect(bubble()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(bubble()).toBeNull();
    // 用户在卡片上点了「开始休息」（store 直接翻段）
    await act(async () => {
      await store.advanceFocus(new Date(T0.getTime() + 26 * 60_000));
    });
    await act(async () => {
      vi.setSystemTime(new Date(T0.getTime() + 31 * 60_000));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(bubble()?.textContent).toContain('休息结束');
  });
});
