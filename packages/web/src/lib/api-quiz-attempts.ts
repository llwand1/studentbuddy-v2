/**
 * api-quiz-attempts — 对话题卡作答记录的 REST 封装（服务端 `routes/quiz.ts` 的 `/:quizId/attempts` 一对，
 * 契约 `docs/QUIZ-REVIEW-SPEC.md`「作答记录」节）。
 * ★ 独立成文件与 `api-drill.ts` 同一个理由：`api.ts` 贴 gates 的「.ts ≤400 行」红线；只依赖 `api-request.ts`。
 */
import type { QuizAttemptInput, QuizAttemptRow, QuizAttemptsView } from '@sb/shared';
import { request } from './api-request.js';

const base = (quizId: string) => `/api/quiz/${encodeURIComponent(quizId)}/attempts`;

export const quizAttemptsApi = {
  /** 这组题的全部记录（没刷过 ⇒ 空 rows） */
  list: (quizId: string) => request<QuizAttemptsView>(base(quizId)),
  /** 记一次作答（判分在题卡上做完了，这里只送结果）→ 服务端累计后的那一行 */
  record: (quizId: string, input: QuizAttemptInput) =>
    request<{ quizId: string; row: QuizAttemptRow }>(base(quizId), { method: 'POST', body: JSON.stringify(input) }),
};
