/**
 * events — 领域事件总线（演进②）：进程内 pub/sub。
 * 发布方：chat/quiz/terms 各域；订阅方：activity（M4 起）。
 * ADR-4：订阅者抛错只记日志，绝不阻塞发布方（对话主链）。
 *
 * ★★ M2d（2026-09-18）：前四个**活动类事件**带上 `ownerId`，且**必填**。
 *
 * 为什么必须带：订阅者 `learning/activity.ts` 要按人记 XP / 每日计数 / 连签，而总线改前
 * 只有「发生了什么」，**不知道这轮是谁在学**——于是三张表只能是全局表，表现为
 * 「A 和 B 的 XP 是同一个数」「B 读到 A 的今日总结」。
 *
 * 为什么**必填**而不是 `ownerId?: string | null`：可选字段的漏传是**静默**的（记进无主行，
 * 用户自己的 XP 少算，测试不覆盖就不红）。必填 ⇒ 每个发布点在 `tsc` 阶段就被要求回答
 * 「这笔算在谁头上」。这与 `routeRole` 的第三参、`bindQuota` 绑在返回值上是同一条思路：
 * **把"记得传"变成"不传编译不过"**。
 *
 * ★ 未登录（本地单人模式）传 `null` —— 语义是「无主」，与 `ownerForWrite` 一致。
 */
import type { ObsEventBody } from '@sb/shared/obs';

export type DomainEvent =
  | { type: 'chat_done'; sessionId: string; ownerId: string | null }
  | { type: 'quiz_generated'; quizId: string; ownerId: string | null }
  | { type: 'quiz_answered'; quizId: string; correct: boolean; ownerId: string | null }
  | { type: 'term_added'; count: number; ownerId: string | null }
  /** 深度理解升级（DEEP-UNDERSTANDING-SPEC §9.2）；XP 订阅在任务 10 接入 */
  | { type: 'evolution_levelup'; termId: string; term: string; from: number; to: number }
  /** 可观测（可观测与数据飞轮方案）；订阅方 storage/obs.ts，发布方 search/flow/quiz/点踩 */
  | ({ type: 'obs' } & ObsEventBody);

type Handler = (ev: DomainEvent) => void | Promise<void>;
const handlers = new Set<Handler>();

export function subscribeEvents(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function publishEvent(ev: DomainEvent): void {
  for (const h of [...handlers]) {
    try {
      void Promise.resolve(h(ev)).catch((err) => {
        console.error('[events] subscriber failed:', err instanceof Error ? err.message : err);
      });
    } catch (err) {
      console.error('[events] subscriber threw:', err instanceof Error ? err.message : err);
    }
  }
}
