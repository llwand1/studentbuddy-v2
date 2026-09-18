/**
 * api-terms-review — 词条复习（艾宾浩斯）REST 封装。
 *
 * ★ 独立成文件与 `api-terms-domain.ts` 同一个理由：`api.ts` 加完本组即撞 gates 的
 *   「.ts ≤400 行」红线（它已 356 行，本组 3 个端点 + 3 个类型约 40 行）。
 * ★ 只依赖 `api-request.ts` 与 `@sb/shared`，**不反向 import `api.ts`**（环断在这里，同前例）。
 * ★ `ReviewState` 直接取 shared 的类型——前端**不自己算**复习状态：判定逻辑的唯一实现
 *   在 `shared/ebbinghaus.ts`，服务端排队列与前端显示徽标必须得到同一个答案
 *   （否则就会出现「列表说该复习、队列里没有它」）。
 */
import { request } from './api-request.js';
import type { ReviewState } from '@sb/shared';

/** 队列/打卡返回的一条词条（含现算好的复习状态） */
export interface ReviewTermItem {
  id: string;
  term: string;
  definition: string;
  domain: string;
  importance: number;
  usage_count: number;
  created_at: string;
  updated_at: string;
  review_stage: number;
  last_reviewed_at: string | null;
  review: ReviewState;
}

/** 单日复习量（供概览里的近 7 天柱状图；缺的天服务端已补 0，前端不必对齐日期） */
export interface ReviewDayStat {
  day: string;
  done: number;
  remembered: number;
}

/** 复习概览（`ReviewOverview` 的字段语义见 `learning/term-review.ts`） */
export interface ReviewOverview {
  total: number;
  due: number;
  overdue: number;
  fresh: number;
  todayDone: number;
  mastered: number;
  maxOverdueDays: number;
  stages: Array<{ stage: number; count: number }>;
  recent: ReviewDayStat[];
}

export const termsReviewApi = {
  /** 概览（今日欠账 / 阶段分布 / 近 7 天） */
  overview: (domain?: string) => {
    const q = domain && domain !== 'all' ? `?domain=${encodeURIComponent(domain)}` : '';
    return request<ReviewOverview>(`/api/terms/review/overview${q}`);
  },
  /** 今日队列（按逾期天数降序 = 先还旧账） */
  queue: (limit?: number, domain?: string) => {
    const q = new URLSearchParams();
    if (limit && limit > 0) q.set('limit', String(limit));
    if (domain && domain !== 'all') q.set('domain', domain);
    const qs = q.toString();
    return request<ReviewTermItem[]>(`/api/terms/review/queue${qs ? `?${qs}` : ''}`);
  },
  /** 打卡：`remembered=true` 推进一个节点，`false` 归零重来 */
  mark: (id: string, remembered: boolean) =>
    request<ReviewTermItem>(`/api/terms/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ remembered }),
    }),
};
