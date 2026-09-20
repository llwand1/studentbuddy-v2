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
import type { ReviewGoal, ReviewState } from '@sb/shared';

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

/** 队列条目（v1.2 起多一个 `segment`，标明它来自三段里的哪一段，契约 §10.3） */
export interface ReviewQueueItem extends ReviewTermItem {
  segment: 'due' | 'extra' | 'repeat';
}

/**
 * 队列响应（v1.2 起是**对象**，契约 §10.7）：条目 + 目标 + 进度 + 池子大小。
 * ★ 目标与进度**必须与队列同源**：分两次请求就可能出现"队列里还有 5 条、进度却说已达标"。
 * ★ `doneCards` 含重复打卡（张数）、`doneTerms` 去重（词条数）——日目标进度看前者（§10.6）。
 * ★ `poolSize` 是在范围内**且未毕业**的词条数：库里可补的本来就不够时，前端要能说清
 *   "只有 N 条可补"，而不是让用户以为队列坏了。
 */
export interface ReviewQueueResult {
  items: ReviewQueueItem[];
  goal: ReviewGoal;
  doneCards: number;
  doneTerms: number;
  poolSize: number;
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
  /** v1.2：今日**张数**（含重复打卡）——日目标进度的分子（契约 §10.6） */
  todayCards: number;
  mastered: number;
  maxOverdueDays: number;
  stages: Array<{ stage: number; count: number }>;
  recent: ReviewDayStat[];
}

/** 复习范围写入结果（v28）：`resetCount` = 因「由关变开」被清零进度的词条数 */
export interface ReviewScopeResult {
  domain?: string;
  id?: string;
  enabled: boolean;
  resetCount: number;
}

export const termsReviewApi = {
  /** 概览（今日欠账 / 阶段分布 / 近 7 天） */
  overview: (domain?: string) => {
    const q = domain && domain !== 'all' ? `?domain=${encodeURIComponent(domain)}` : '';
    return request<ReviewOverview>(`/api/terms/review/overview${q}`);
  },
  /**
   * 今日队列（v1.2：**三段补位** 真账 → 提前背 → 重复巩固，契约 §10.3）。
   * ★ 响应 v1.2 起是**对象**（多了目标与进度）；未设目标时 `limit` 生效，设了则以 `goal.count` 为准。
   */
  queue: (limit?: number, domain?: string) => {
    const q = new URLSearchParams();
    if (limit && limit > 0) q.set('limit', String(limit));
    if (domain && domain !== 'all') q.set('domain', domain);
    const qs = q.toString();
    return request<ReviewQueueResult>(`/api/terms/review/queue${qs ? `?${qs}` : ''}`);
  },
  /** 读自定义复习目标（v1.2，契约 §10.2）。未配过回默认 `{count:0,domains:[]}`（＝关闭） */
  goal: () => request<ReviewGoal>('/api/terms/review/goal'),
  /**
   * 设自定义复习目标（v1.2）。`count = 0` 表示**关闭**（队列退回只放到期，＝ v1.1 行为）。
   * ★ 服务端归一后落库并**回写归一结果**，故以返回值为准更新本地状态——不拿自己发上去的值当结果
   *   （否则用户输 9999 时界面显示 9999，而库里存的是 200）。
   */
  setGoal: (goal: ReviewGoal) =>
    request<ReviewGoal>('/api/terms/review/goal', { method: 'PUT', body: JSON.stringify(goal) }),
  /** 打卡：`remembered=true` 推进一个节点，`false` 归零重来。未纳入范围的词条会被 409 拒掉 */
  mark: (id: string, remembered: boolean) =>
    request<ReviewTermItem>(`/api/terms/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ remembered }),
    }),

  // ── 复习范围（v28 选择式复习，契约 EBBINGHAUS-SPEC §9）──
  // ★ `enabled` 传的是**目标有效值**（"以后复不复习"），不是"往列里写什么"——
  //   写 NULL（继承领域）还是写显式 0/1 由服务端按"是否偏离领域默认"决定。
  //   前端若自己决定写哪一列，就等于把优先级规则抄了第二份。
  /** 领域级：点一下整个领域进/出复习范围（不动词条级覆盖位） */
  scopeDomain: (domain: string, enabled: boolean) =>
    request<ReviewScopeResult>('/api/terms/review/scope', {
      method: 'PUT',
      body: JSON.stringify({ domain, enabled }),
    }),
  /** 词条级：单条加入/移出复习范围 */
  scopeTerm: (termId: string, enabled: boolean) =>
    request<ReviewScopeResult>('/api/terms/review/scope', {
      method: 'PUT',
      body: JSON.stringify({ termId, enabled }),
    }),
};
