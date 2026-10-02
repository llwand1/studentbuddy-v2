/**
 * pomodoro-store — 番茄钟的跨组件状态（契约 `docs/POMODORO-SPEC.md` §6）。
 *
 * 为什么是一个模块级小 store 而不是 props：番茄钟一头长在词条页的复习列表里（开钟卡），一头长在右下角督促胶囊旁
 * （倒计时与提醒），还要喂给引路灯（方向）与刷词（方向内词条排前）——四处隔着 App 壳层，props 穿不过去。
 * 与 `drill-dock` 同一思路：`useSyncExternalStore` 保证四处同一帧一致。
 *
 * ★ 真相在服务端（`/api/pomodoro`）：本 store 只是镜像 + 写口；每次写都以服务端回写值为准。
 * ★ 翻段 / 跳过 / 结束的算法只有 shared 一份，这里只负责「算好 → PUT → 落镜像」。
 * ★ 「还没设钟」提醒的时间戳记本机（`localStorage`）：它是**这台设备**上「别烦我」的记忆，不该跨设备同步。
 */
import { useSyncExternalStore } from 'react';
import { nextPomodoroPhase, skipBreak, startPomodoro, type PomodoroSession } from '@sb/shared';
import { pomodoroApi } from '../../lib/api-pomodoro';

export const POMODORO_OPEN_EVENT = 'sb:pomodoro-open';
const SETUP_NUDGE_KEY = 'sb_pomodoro_setup_nudge_at';

interface State {
  session: PomodoroSession | null;
  /** 第一次 GET 回来之前为 false：此时既不该提醒「没设钟」，也不该显示倒计时 */
  loaded: boolean;
}

let state: State = { session: null, loaded: false };
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
function set(next: Partial<State>): void {
  state = { ...state, ...next };
  emit();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const readPomodoro = (): State => state;
export function usePomodoro(): State {
  return useSyncExternalStore(subscribe, readPomodoro, readPomodoro);
}

/** 应用启动时拉一次；失败（没起服务 / 未登录）当没开钟，不打断别的功能 */
export async function loadPomodoroState(): Promise<void> {
  try {
    const r = await pomodoroApi.get();
    set({ session: r.session, loaded: true });
  } catch {
    set({ loaded: true });
  }
}

async function commit(session: PomodoroSession): Promise<PomodoroSession> {
  const r = await pomodoroApi.put(session);
  set({ session: r.session });
  return r.session ?? session;
}

export async function startFocus(input: { subject: string; workMin: number }, now = new Date()): Promise<PomodoroSession | null> {
  const s = startPomodoro(input, now);
  if (!s) return null;
  return commit(s);
}

/** 翻到下一段（工作→休息 / 休息→下一轮）；没开钟就什么都不做 */
export async function advanceFocus(now = new Date()): Promise<void> {
  if (!state.session) return;
  await commit(nextPomodoroPhase(state.session, now));
}

/** 工作段「再来一轮」：跳过休息；休息段 = 结束休息 */
export async function skipFocusBreak(now = new Date()): Promise<void> {
  if (!state.session) return;
  await commit(skipBreak(state.session, now));
}

export async function stopFocus(): Promise<void> {
  await pomodoroApi.clear();
  set({ session: null });
}

/** 测试用：回到出厂 */
export function resetPomodoroStore(): void {
  state = { session: null, loaded: false };
  emit();
}

// ── 「还没设钟」提醒的本机记忆 ──
export function readSetupNudgeAt(): Date | null {
  try {
    const raw = window.localStorage.getItem(SETUP_NUDGE_KEY);
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? new Date(t) : null;
  } catch {
    return null;
  }
}
export function markSetupNudged(now = new Date()): void {
  try {
    window.localStorage.setItem(SETUP_NUDGE_KEY, now.toISOString());
  } catch {
    /* 存不进去就算了：最多这台设备多提醒一次 */
  }
}

/** 请 App 跳到词条页并展开开钟卡（气泡 / 引路灯 / 任何入口都走这一条） */
export function requestPomodoroOpen(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(POMODORO_OPEN_EVENT));
}
