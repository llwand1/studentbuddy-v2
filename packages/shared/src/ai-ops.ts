/**
 * shared/ai-ops — AI 网关统计、学习事件流、后台任务三块的**前后端共用形状**（2026-09-29，v46）。
 * 只放类型与白名单常量，不放逻辑。
 */

// ── AI 调用统计（`GET /api/ai/stats`）──
export interface AiPurposeStats {
  purpose: string;
  label: string;
  /** 最近一次调用用的提示词版本 */
  version: number;
  calls: number;
  ok: number;
  /** 失败按原因计数：no-model / timeout / aborted / upstream / parse */
  failures: Record<string, number>;
  /** 成功调用的耗时分位（毫秒） */
  p50Ms: number;
  p95Ms: number;
  tokens: number;
}

export interface AiCallStats {
  days: number;
  calls: number;
  ok: number;
  purposes: AiPurposeStats[];
  recentFailures: Array<{ purpose: string; label: string; status: string; error: string; at: string }>;
}

// ── 学习事件流（`learning_event`）──
export const LEARNING_EVENT_KINDS = ['term.added', 'term.reviewed', 'quiz.answered', 'quiz.generated', 'chat.turn'] as const;
export type LearningEventKind = (typeof LEARNING_EVENT_KINDS)[number];

export interface LearningDay {
  day: string;
  reviews: number;
  remembered: number;
  answers: number;
  correct: number;
  termsAdded: number;
  chats: number;
}

export interface LearningSummary {
  days: LearningDay[];
  /** 连续学习天数（今天还没学不算断） */
  streak: number;
  totals: {
    reviews: number;
    /** 复习记住率；没有复习时为 null（不是 0：没考过 ≠ 全忘了） */
    rememberRate: number | null;
    answers: number;
    accuracy: number | null;
    termsAdded: number;
    chats: number;
  };
}

export interface LearningTimelineItem {
  kind: LearningEventKind;
  at: string;
  day: string;
  payload: Record<string, unknown> | null;
}

/** 前端可以上报的答题事件（`POST /api/learning/answers`） */
export const ANSWER_QTYPES = ['choice', 'judge', 'fill', 'match', 'scene', 'short', 'multi'] as const;
export type AnswerQType = (typeof ANSWER_QTYPES)[number];
export const ANSWER_SOURCES = ['chat-quiz', 'scenario', 'continent', 'pk', 'review'] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

// ── 后台任务（`GET /api/jobs`）──
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobView {
  id: string;
  kind: string;
  label: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
