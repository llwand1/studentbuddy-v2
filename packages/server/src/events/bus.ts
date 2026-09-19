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
import type { ToolConfirmDecision } from '@sb/shared';

export type DomainEvent =
  | { type: 'chat_done'; sessionId: string; ownerId: string | null }
  | { type: 'quiz_generated'; quizId: string; ownerId: string | null }
  | { type: 'quiz_answered'; quizId: string; correct: boolean; ownerId: string | null }
  | { type: 'term_added'; count: number; ownerId: string | null }
  /** 深度理解升级（DEEP-UNDERSTANDING-SPEC §9.2）；XP 订阅在任务 10 接入 */
  | { type: 'evolution_levelup'; termId: string; term: string; from: number; to: number }
  /** 可观测（可观测与数据飞轮方案）；订阅方 storage/obs.ts，发布方 search/flow/quiz/点踩 */
  | ({ type: 'obs' } & ObsEventBody)
  /**
   * 工具生态 P3 审计（TOOL-ECOSYSTEM-SPEC §4.5，v1.4 拍板⑰）：调度器（chat/tool-exec.ts）**单点**
   * 发布，订阅方 storage/tool-stats.ts 落 `tool_stats`。走总线而不是调度器直写库，是抄
   * `obs` 的既有分工（发布方对观测零感知、ADR-4 订阅者抛错不阻塞主链），也守住 tool-exec 的
   * 「不触 DB」测试边界——getDb() 惰性开真库，测试里误触就会在开发机上生成真文件。
   * ★ `affected` 只有过确认门/免确认的**写类**工具有值（§4.6「已知绕过面」的事后审计全靠它），
   *   读/网络/被拒留 null（null≠0：没改，与改了 0 条是两回事——v32 耗时列同口径）。
   * ★ `confirm`：null＝没经过门（免确认档）；否则为用户/超时的裁决，「放行与拒绝都要留痕」。
   */
  | {
      type: 'tool_called';
      sessionId: string | null;
      ownerId: string | null;
      tool: string;
      source: 'builtin' | 'mcp';
      ok: boolean;
      ms: number;
      affected: number | null;
      resultChars: number;
      err: string | null;
      confirm: ToolConfirmDecision | null;
    };

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
