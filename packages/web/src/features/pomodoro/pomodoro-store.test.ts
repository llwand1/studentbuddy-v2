// @vitest-environment jsdom
/**
 * pomodoro-store：镜像 + 写口（契约 `docs/POMODORO-SPEC.md` §6）。REST 整体替身，锁的是编排：
 *  ① 启动拉一次：成功落镜像、失败也置 `loaded`（当没开钟，不卡住别的功能）；
 *  ② 开钟 / 翻段 / 跳过 / 结束都以**服务端回写**为准，且算法来自 shared（翻段后 phase / round 对得上）；
 *  ③ 「还没设钟」时间戳记本机、读得回来、坏值当没有；`requestPomodoroOpen` 发 `sb:pomodoro-open`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PomodoroSession } from '@sb/shared';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), clear: vi.fn() }));
vi.mock('../../lib/api-pomodoro', () => ({ pomodoroApi: api }));

const mod = await import('./pomodoro-store');

beforeEach(() => {
  localStorage.clear();
  mod.resetPomodoroStore();
  api.get.mockReset();
  api.put.mockReset();
  api.clear.mockReset();
  // 服务端原样回写
  api.put.mockImplementation(async (s: PomodoroSession) => ({ session: s, focus: null }));
  api.clear.mockResolvedValue({ session: null, focus: null });
});
afterEach(() => vi.restoreAllMocks());

describe('① 启动', () => {
  it('GET 成功落镜像并置 loaded；失败也置 loaded、session 为 null', async () => {
    const s = (await (async () => {
      api.get.mockResolvedValue({ session: { subject: '数学' }, focus: null });
      await mod.loadPomodoroState();
      return mod.readPomodoro();
    })()) as { session: { subject: string } | null; loaded: boolean };
    expect(s.loaded).toBe(true);
    expect(s.session?.subject).toBe('数学');
    mod.resetPomodoroStore();
    api.get.mockRejectedValue(new Error('offline'));
    await mod.loadPomodoroState();
    expect(mod.readPomodoro()).toEqual({ session: null, loaded: true });
  });
});

describe('② 写口', () => {
  it('开钟 → 休息 → 下一轮 → 结束：每步 PUT 一次、镜像跟着服务端回写走', async () => {
    const T0 = new Date('2026-10-01T08:00:00Z');
    const s1 = await mod.startFocus({ subject: '数学', workMin: 30 }, T0);
    expect(s1?.phase).toBe('work');
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(mod.readPomodoro().session?.subject).toBe('数学');
    await mod.advanceFocus(new Date(T0.getTime() + 30 * 60_000));
    expect(mod.readPomodoro().session?.phase).toBe('break');
    expect(mod.readPomodoro().session?.completed).toBe(1);
    await mod.advanceFocus(new Date(T0.getTime() + 35 * 60_000));
    expect(mod.readPomodoro().session?.phase).toBe('work');
    expect(mod.readPomodoro().session?.round).toBe(2);
    await mod.skipFocusBreak(new Date(T0.getTime() + 40 * 60_000));
    expect(mod.readPomodoro().session?.round).toBe(3);
    await mod.stopFocus();
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(mod.readPomodoro().session).toBeNull();
    // 没开钟时翻段 / 跳过是空操作
    await mod.advanceFocus();
    await mod.skipFocusBreak();
    expect(api.put).toHaveBeenCalledTimes(4);
  });

  it('方向为空 ⇒ 不开钟、不打接口；镜像以服务端回写为准（服务端截短了方向就显示截短的）', async () => {
    expect(await mod.startFocus({ subject: '   ', workMin: 25 })).toBeNull();
    expect(api.put).not.toHaveBeenCalled();
    api.put.mockImplementation(async (s: PomodoroSession) => ({ session: { ...s, subject: '服务端改过' }, focus: null }));
    await mod.startFocus({ subject: '数学', workMin: 25 });
    expect(mod.readPomodoro().session?.subject).toBe('服务端改过');
  });
});

describe('③ 本机记忆与跨组件事件', () => {
  it('setup 提醒时间戳：写 → 读一致；坏值 ⇒ null；requestPomodoroOpen 发事件', () => {
    expect(mod.readSetupNudgeAt()).toBeNull();
    const t = new Date('2026-10-01T09:00:00Z');
    mod.markSetupNudged(t);
    expect(mod.readSetupNudgeAt()?.getTime()).toBe(t.getTime());
    localStorage.setItem('sb_pomodoro_setup_nudge_at', 'garbage');
    expect(mod.readSetupNudgeAt()).toBeNull();
    const seen = vi.fn();
    window.addEventListener(mod.POMODORO_OPEN_EVENT, seen);
    mod.requestPomodoroOpen();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
