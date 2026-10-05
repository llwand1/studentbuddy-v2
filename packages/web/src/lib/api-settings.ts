/**
 * api-settings — 设置域端点封装（搜索 key / 出题配比 / 配图开关 / 回答方式 / 词条朗读）。
 *
 * ★ **为什么从 `api.ts` 拆出来**：`api.ts` 是全仓 REST 封装的单一出口，本次加「词条朗读」
 *   三方法后触 `web/.ts ≤400` 红线（`api.ts` 此前已 398 行、正贴着线）。按仓规**拆文件不压注释**。
 *   方向与仓内先例一致：`api-request.ts`（最低层：`ApiError` / `request`）→ `api.ts`（主出口）
 *   → 本文件（按域拆出）——三者都指向 `api-request.ts`，**不构成环**（这正是当初把
 *   `ApiError`/`request` 抽成底层文件时为「按域拆 api」预留的路）。
 * ★ **消费面零改动**：`api.ts` 里仍是 `settings: settingsApi`，调用方照旧写 `api.settings.speech()`。
 */
import type {
  AnswerStyle,
  ExamPacksView,
  ExamModeView,
  ExamScopeSaveView,
  ExamScopeSetting,
  QuizMix,
  QuizSourceMix,
  SpeechSettings,
} from '@sb/shared';
import { request } from './api-request.js';

export const settingsApi = {
  searchKeys: () => request<{ configured: Record<'tinyfish' | 'exa' | 'tavily' | 'zhipu', boolean> }>('/api/settings/search-keys'),
  saveSearchKeys: (patch: Partial<Record<'tinyfish' | 'exa' | 'tavily' | 'zhipu', string>>) =>
    request<{ ok: boolean; configured: Record<'tinyfish' | 'exa' | 'tavily' | 'zhipu', boolean> }>('/api/settings/search-keys', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  testSearch: (query?: string) =>
    request<{
      ok: boolean;
      count: number;
      providers: string[];
      failed: string[];
      /** 开着应试模式时回范围账（范围内命中几条、范围外滤掉几条） */
      scope?: { summary: string; dropped: number };
    }>('/api/settings/search/test', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
  /** 出题题型配比：设置页读写，服务端归一回读；只有对话页出题读这份全局配比（对战按 PK_QUIZ_MIX 现算） */
  quizMix: () => request<{ mix: QuizMix }>('/api/settings/quiz-mix'),
  saveQuizMix: (mix: QuizMix) =>
    request<{ mix: QuizMix }>('/api/settings/quiz-mix', { method: 'PUT', body: JSON.stringify({ mix }) }),
  /**
   * 出题**来源**配比（每题型的真题道数；契约 docs/QUIZ-BLEND-SPEC.md §3.1）。
   * 服务端会按当前 AI 配比做**联合钳位**再落库，回读的是实际生效值——前端拿它回填就是所见即所得。
   */
  quizSourceMix: () => request<{ mix: QuizSourceMix }>('/api/settings/quiz-source-mix'),
  saveQuizSourceMix: (mix: QuizSourceMix) =>
    request<{ mix: QuizSourceMix }>('/api/settings/quiz-source-mix', { method: 'PUT', body: JSON.stringify({ mix }) }),
  /** 出题配图开关：设置页读写（契约 docs/QUIZ-IMAGE-SPEC.md） */
  /** 真题优先（契约 docs/QUIZ-TIER-SPEC.md §4）：缺省开——没配真题配比也先去公开题源摘真题顶替 AI 题 */
  quizRealFirst: () => request<{ on: boolean }>('/api/settings/quiz-real-first'),
  /**
   * 应试模式（契约 docs/EXAM-MODE-SPEC.md §5，EXAM-1004）。
   * ★ 读写都回**实际生效值**：范围在服务端做归一化与钳位（非法域名丢弃、超上限截断），
   *   前端拿回读值回填才是所见即所得。
   */
  examPacks: () => request<ExamPacksView>('/api/settings/exam-packs'),
  examMode: () => request<ExamModeView>('/api/settings/exam-mode'),
  saveExamMode: (on: boolean) =>
    request<ExamModeView & { ok: boolean }>('/api/settings/exam-mode', { method: 'PUT', body: JSON.stringify({ on }) }),
  saveExamScope: (scope: ExamScopeSetting) =>
    request<ExamScopeSaveView>('/api/settings/exam-scope', { method: 'PUT', body: JSON.stringify(scope) }),
  saveQuizRealFirst: (on: boolean) =>
    request<{ ok: boolean; on: boolean }>('/api/settings/quiz-real-first', { method: 'PUT', body: JSON.stringify({ on }) }),
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
