import type { OpenQuizRound, QuizRound, QuizRoundResponse, QuizDraftAnswer, QuizRoundHistory } from '@sb/shared';
import { request } from './api-request';
export interface RoundDraftChange { index: number; revision: number; draft: QuizDraftAnswer; thought: string }
const path = (id: string) => `/api/quiz/rounds/${encodeURIComponent(id)}`;
export const quizRoundsApi = {
  open: (input: OpenQuizRound, signal?: AbortSignal) => request<QuizRound>('/api/quiz/rounds/open', { method: 'POST', body: JSON.stringify(input), signal }),
  get: (id: string) => request<QuizRound>(path(id)),
  save: (id: string, change: RoundDraftChange) => request<QuizRoundResponse>(`${path(id)}/answer`, { method: 'PATCH', body: JSON.stringify(change), timeoutMs: 15000 }),
  submit: (id: string, changes: RoundDraftChange[]) => request<QuizRound>(`${path(id)}/submit`, { method: 'POST', body: JSON.stringify({ changes }), timeoutMs: 20000 }),
  next: (id: string) => request<QuizRound>(`${path(id)}/new`, { method: 'POST' }),
  retry: (id: string, index: number) => request<QuizRound>(`${path(id)}/questions/${index}/retry`, { method: 'POST' }),
  cancel: (id: string) => request<QuizRound>(`${path(id)}/cancel`, { method: 'POST' }),
  events: (id: string) => `${path(id)}/events`,
  history: (before?: string) => request<QuizRoundHistory>(`/api/quiz/round-history${before ? `?before=${encodeURIComponent(before)}` : ''}`),
};
