/**
 * api-ai-ops — AI 运行状况、学习汇总、后台任务的 REST 封装（服务端 `routes/ai-ops.ts` 逐字对应）。
 * ★ 独立成文件（`api.ts` 贴着 400 行红线）；只依赖 `api-request.ts`。
 */
import type { TermRelationView, GradeRequest, GradeResult, LearnerModel, AiCallStats, AnswerQType, AnswerSource, JobStatus, JobView, LearningSummary, LearningTimelineItem, QuizQuestion } from '@sb/shared';
import { request } from './api-request.js';

export interface AnswerReport {
  correct: boolean;
  qtype?: AnswerQType;
  ms?: number;
  termId?: string;
  source?: AnswerSource;
}

export interface JobsResponse {
  jobs: JobView[];
  counts: Record<JobStatus, number>;
}

/** 前端题型 → 学习事件题型。解答题没有对错（只对照参考），返回 null＝不上报，免得拉低正确率。 */
export function answerQType(t: QuizQuestion['type']): AnswerQType | null {
  return ({ single: 'choice', multiple: 'multi', judge: 'judge', fill: 'fill' } as const)[t as 'single'] ?? null;
}

export const aiOpsApi = {
  stats: (days = 7) => request<AiCallStats>(`/api/ai/stats?days=${days}`),
  summary: (days = 14) => request<LearningSummary>(`/api/learning/summary?days=${days}`),
  timeline: (termId: string) => request<{ items: LearningTimelineItem[] }>(`/api/learning/terms/${encodeURIComponent(termId)}/timeline`),
  jobs: () => request<JobsResponse>('/api/jobs'),
  retryJob: (id: string) => request<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  answers: (items: AnswerReport[]) => request<{ accepted: number }>('/api/learning/answers', { method: 'POST', body: JSON.stringify({ items }) }),
  /** AI 按量规判填空/解答题（服务端同时记误区与学习事件，前端对这类题不再自己上报） */
  grade: (req: GradeRequest, signal?: AbortSignal) =>
    request<GradeResult>('/api/learning/grade', { method: 'POST', body: JSON.stringify(req), timeoutMs: 60_000, ...(signal ? { signal } : {}) }),
  model: () => request<LearnerModel>('/api/learning/model'),
  relations: (termId: string) => request<{ items: TermRelationView[] }>(`/api/learning/terms/${encodeURIComponent(termId)}/relations`),
  resolveMisconception: (id: string) => request<{ ok: true }>(`/api/learning/misconceptions/${encodeURIComponent(id)}/resolve`, { method: 'POST' }),
  /**
   * 答题上报：**发了就不管**。学习统计是锦上添花，离线、未登录、服务端 400 都不能打断答题本身。
   */
  reportAnswer(item: AnswerReport): void {
    void this.answers([item]).catch(() => undefined);
  },
};
