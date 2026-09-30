/**
 * drill-dock — 刷词小窗「收起 / 唤回」的跨组件状态（2026-09-30；契约 `docs/WAIT-DRILL-SPEC.md` §2.1）。
 *
 * 用户的原话：回复等待时的百词斩应该能**唤回来**。此前 ✕ / Esc / 回复到了自动切回 = 整局作废，下一轮才能再见到它，
 * 想接着刷只能去设置页点「试一局」重开一局。现在关掉只是**收起**：队列、连击、本局战绩都留在 `WaitDrill`（App 壳层常驻），
 * 输入框上方留一枚「刷词已收起 · 还有 N 张」的小签，点它同一局原样回来；签上的 ✕ 才是真正结束本局。
 *
 * ★ 为什么是一个模块级小 store 而不是 props：小窗挂在 App 壳层，小签长在 `ChatComposer` 里（对话页），中间隔着
 *   `ChatView`（贴着行数红线，见其头注）。与既有 `sb:drill-open` 事件同一思路：宿主写、入口读、谁也不穿透谁。
 *   `useSyncExternalStore` 保证小签与宿主同一帧一致；`requestDrillEnd` 走 window 事件（与 `requestDrillOpen` 对称）。
 */
import { useSyncExternalStore } from 'react';

export interface DrillDockState {
  /** 有一局在跑但小窗收起了（此时该露小签） */
  parked: boolean;
  queueLeft: number;
  correct: number;
  combo: number;
}

export const DRILL_END_EVENT = 'sb:drill-end';

const IDLE: DrillDockState = { parked: false, queueLeft: 0, correct: 0, combo: 0 };
let state: DrillDockState = IDLE;
const listeners = new Set<() => void>();

function same(a: DrillDockState, b: DrillDockState): boolean {
  return a.parked === b.parked && a.queueLeft === b.queueLeft && a.correct === b.correct && a.combo === b.combo;
}

/** 宿主（`WaitDrill`）每次状态变化写一份；没变不广播 */
export function setDrillDock(next: DrillDockState): void {
  if (same(state, next)) return;
  state = next;
  listeners.forEach((l) => l());
}

export function resetDrillDock(): void {
  setDrillDock(IDLE);
}

export function readDrillDock(): DrillDockState {
  return state;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDrillDock(): DrillDockState {
  return useSyncExternalStore(subscribe, readDrillDock, readDrillDock);
}

/** 小签上的 ✕：结束这一局（队列与本局战绩清掉；当天战绩已落本机，不受影响） */
export function requestDrillEnd(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DRILL_END_EVENT));
}
