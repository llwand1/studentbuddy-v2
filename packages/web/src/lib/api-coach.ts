/**
 * api-coach — 复习督促小窗 REST/SSE 封装（v25，契约 `docs/COACH-SPEC.md`）。
 *
 * ★ 类型**直接取 `@sb/shared` 的 `CoachCard` / `CoachSnapshot`**，前端不复制一份：
 *   卡片种类还会长（老板明说"可开发点很多"），复制一份就等于每次加卡都要改两处，
 *   而漏改的那一处不会报错、只会渲染成空白。
 * ★ 独立成文件（不塞进 `api.ts`）：`api.ts` 已 356 行，触 gates 的「.ts ≤400 行」红线；
 *   且它只依赖 `api-request.ts`，不反向 import `api.ts`（环断在这里，同 `api-terms-review.ts`）。
 */
import { request } from './api-request.js';
import type { CoachCard, CoachNudge, CoachSnapshot } from '@sb/shared';

/** `GET /api/coach/state`：快照 + 「该不该催」判定 + 上次提醒时间 */
export interface CoachStateResp {
  snapshot: CoachSnapshot;
  nudge: CoachNudge;
  lastNudgeAt: string | null;
}

/** `GET /api/coach/messages`：流水 + 快照（开抽屉一次往返拿齐） */
export interface CoachMessagesResp {
  cards: CoachCard[];
  snapshot: CoachSnapshot;
}

export const coachApi = {
  state: () => request<CoachStateResp>('/api/coach/state'),
  messages: (limit = 60) => request<CoachMessagesResp>(`/api/coach/messages?limit=${limit}`),
  /**
   * 主动提醒。`card` 为 `null` 是**正常结果**（冷却期内 / 今天不欠账），不是错误——
   * 调用方据此保持安静即可，不要显示任何提示。
   */
  nudge: () => request<{ card: CoachCard | null; reason: string }>('/api/coach/nudge', { method: 'POST' }),
  send: (text: string) =>
    request<{ ok: boolean; card: CoachCard }>('/api/coach/send', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  /** 小窗内复习打卡（记得 / 忘了）；返回一张写进流水的动作卡 */
  review: (termId: string, remembered: boolean) =>
    request<{ card: CoachCard }>('/api/coach/review', {
      method: 'POST',
      body: JSON.stringify({ termId, remembered }),
    }),
  abort: () => request<{ ok: boolean }>('/api/coach/abort', { method: 'POST' }),
};

/** SSE 流地址（复用 `lib/sse-client`，与聊天/PK 同一条实现：退避重连 + seq 去重） */
export const COACH_STREAM_URL = '/api/coach/stream';
/** 断线重连后的快照对齐地址（SSE-CONTRACT 的「断线恢复」） */
export const COACH_LIVE_URL = '/api/coach/live';
