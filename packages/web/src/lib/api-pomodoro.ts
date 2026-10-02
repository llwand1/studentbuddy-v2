/**
 * api-pomodoro — 番茄钟 REST 封装（契约 `docs/POMODORO-SPEC.md` §4，前缀 `/api/pomodoro`）。
 * ★ 独立成文件（同 `api-guide.ts`）：只依赖 `api-request.ts`，不反向 import `api.ts`。
 */
import type { PomodoroFocus, PomodoroSession } from '@sb/shared';
import { request } from './api-request.js';

export interface PomodoroState {
  session: PomodoroSession | null;
  focus: PomodoroFocus | null;
}

export const pomodoroApi = {
  get: () => request<PomodoroState>('/api/pomodoro'),
  put: (session: PomodoroSession) => request<PomodoroState>('/api/pomodoro', { method: 'PUT', body: JSON.stringify({ session }) }),
  clear: () => request<PomodoroState>('/api/pomodoro', { method: 'DELETE' }),
};
