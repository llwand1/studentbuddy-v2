/**
 * quiz-wait — 「出题中」也算等待（契约 `docs/POMODORO-SPEC.md` §8 / `WAIT-DRILL-SPEC.md` §2.2）。
 *
 * 等待时刷词原本只盯 `localBusySid`（对话流在生成）。出一组题常要二三十秒、情景题更久，而那段时间
 * `busySessionId` 是空的——用户同样干等着。本 store 让出题动作域（`use-quiz-actions`）把「哪间会话正在出题」
 * 写一份，App 把它与 `localBusySid` 并成一个信号喂给 `WaitDrill`：弹 / 回的时机、2 秒表、本轮不再弹，全部照旧。
 * ★ 与 `drill-dock` 同一思路：宿主读、动作域写、谁也不穿透谁（ChatView 贴着行数红线）。
 */
import { useSyncExternalStore } from 'react';

let state: string | null = null;
const listeners = new Set<() => void>();

export function setQuizWait(sessionId: string | null): void {
  if (state === sessionId) return;
  state = sessionId;
  listeners.forEach((l) => l());
}
export const readQuizWait = (): string | null => state;
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useQuizWait(): string | null {
  return useSyncExternalStore(subscribe, readQuizWait, readQuizWait);
}
