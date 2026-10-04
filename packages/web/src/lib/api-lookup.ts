/**
 * api-lookup —— 划词速查小窗的三个请求（契约 `docs/LOOKUP-SPEC.md` §4）。
 *
 * 三条都**不挂会话**：小窗的答案不进对话历史，这是「不污染原对话」的技术落点。
 */
import type { LookupAnswer, LookupContext, WikiLookup } from '@sb/shared';
import { request } from './api-request';

/** 维基条目：免费、不烧模型额度，所以小窗默认先打这一条 */
export function lookupWiki(term: string, lang: string, signal?: AbortSignal): Promise<WikiLookup> {
  const q = new URLSearchParams({ q: term, lang });
  return request<WikiLookup>(`/api/lookup/wiki?${q.toString()}`, { signal });
}

export function lookupExplain(ctx: LookupContext, signal?: AbortSignal): Promise<LookupAnswer> {
  return request<LookupAnswer>('/api/lookup/explain', { method: 'POST', body: JSON.stringify(ctx), signal });
}

export function lookupQuiz(ctx: LookupContext, signal?: AbortSignal): Promise<LookupAnswer> {
  return request<LookupAnswer>('/api/lookup/quiz', { method: 'POST', body: JSON.stringify(ctx), signal });
}
