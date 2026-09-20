/**
 * api-settings — 设置域端点封装（搜索 key / 出题配比 / 配图开关 / 回答方式 / 词条朗读）。
 *
 * ★ **为什么从 `api.ts` 拆出来**：`api.ts` 是全仓 REST 封装的单一出口，本批加「词条朗读」
 *   三方法后触 `web/.ts ≤400` 红线（`api.ts` 此前已 398 行、正贴着线）。按仓规**拆文件不压注释**。
 *   方向与仓内先例一致：`api-request.ts`（最低层：`ApiError` / `request`）→ `api.ts`（主出口）
 *   → 本文件（按域拆出）——三者都指向 `api-request.ts`，**不构成环**（这正是当初把
 *   `ApiError`/`request` 抽成底层文件时为「按域拆 api」预留的路）。
 * ★ **消费面零改动**：`api.ts` 里仍是 `settings: settingsApi`，调用方照旧写 `api.settings.speech()`。
 */
import type { AnswerStyle, QuizMix, SpeechSettings } from '@sb/shared';
import { request } from './api-request.js';

export const settingsApi = {
  searchKeys: () => request<{ configured: Record<'exa' | 'tavily' | 'zhipu', boolean> }>('/api/settings/search-keys'),
  saveSearchKeys: (patch: Partial<Record<'exa' | 'tavily' | 'zhipu', string>>) =>
    request<{ ok: boolean; configured: Record<'exa' | 'tavily' | 'zhipu', boolean> }>('/api/settings/search-keys', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  testSearch: (query?: string) =>
    request<{ ok: boolean; count: number; providers: string[]; failed: string[] }>('/api/settings/search/test', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
  /** 出题题型配比：设置页读写，服务端归一回读；对话页/题库页只读这份全局配比 */
  quizMix: () => request<{ mix: QuizMix }>('/api/settings/quiz-mix'),
  saveQuizMix: (mix: QuizMix) =>
    request<{ mix: QuizMix }>('/api/settings/quiz-mix', { method: 'PUT', body: JSON.stringify({ mix }) }),
  /** 出题配图开关：设置页读写（契约 docs/QUIZ-IMAGE-SPEC.md） */
  quizImage: () => request<{ on: boolean }>('/api/settings/quiz-image'),
  saveQuizImage: (on: boolean) =>
    request<{ ok: boolean; on: boolean }>('/api/settings/quiz-image', { method: 'PUT', body: JSON.stringify({ on }) }),
  /** 回答方式偏好（契约 docs/ANSWER-STYLE-SPEC.md）：configured 是「出题前要不要问」的开关量 */
  answerStyle: () => request<{ style: AnswerStyle; configured: boolean }>('/api/settings/answer-style'),
  saveAnswerStyle: (style: AnswerStyle) =>
    request<{ style: AnswerStyle; configured: boolean }>('/api/settings/answer-style', {
      method: 'PUT',
      body: JSON.stringify({ style }),
    }),
  /** 恢复默认＝删键，回到「没配过」态（不是把四维写成默认值，那样 configured 仍为 true） */
  resetAnswerStyle: () =>
    request<{ style: AnswerStyle; configured: boolean }>('/api/settings/answer-style', { method: 'DELETE' }),
  /** 词条朗读设置（音色 / 语速，契约 shared/src/speech.ts）：对话里词条喇叭按钮用的就是这套 */
  speech: () => request<{ settings: SpeechSettings }>('/api/settings/speech'),
  saveSpeech: (settings: SpeechSettings) =>
    request<{ ok: boolean; settings: SpeechSettings }>('/api/settings/speech', {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    }),
  /** 恢复默认＝删键，回到「系统默认英文音色 + 正常语速」 */
  resetSpeech: () => request<{ settings: SpeechSettings }>('/api/settings/speech', { method: 'DELETE' }),
};
