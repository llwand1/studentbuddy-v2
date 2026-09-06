/**
 * @sb/shared — 可观测契约（可观测与数据飞轮方案 §2.1，2026-09-06）。
 *
 * 单一事实源：事件种类 / 事件体 / 查询响应行，前后端共用一份。
 * `low_confidence` / `no_evidence` 为真 RAG 阶段置信度闸门预留位——观测与建池链路对它们
 * 零假设，RAG 上线后直接 publishEvent 即接入，本契约不改。
 * 经子路径出口 `@sb/shared/obs` 引用（shared/index.ts 当前被 doc-RAG 批占用，
 * 为避免多 AI 并发编辑同一文件，本契约走 package.json exports 子路径，第二批再补 re-export）。
 */

/** 观测事件种类。新增成员 = 先登记这里再实现发布点（契约先行，同 sse-events 纪律）。 */
export const OBS_KINDS = [
  'tool_error',          // 工具轮执行失败（search_web / tidy_terms）
  'budget_cutoff',       // 上下文预算提前收口
  'quiz_parse_fallback', // 出题解析走了回退（补括号 / 剥图 / 逐题）
  'quiz_svg_dropped',    // 丢图保题
  'search_empty',        // 搜索零结果 / 全 provider 失败
  'thumbs_down',         // 用户点踩（M-B 接入）
  'low_confidence',      // 预留：置信度闸门（真 RAG）
  'no_evidence',         // 预留：证据不足拒答（真 RAG）
] as const;

export type ObsKind = (typeof OBS_KINDS)[number];

/**
 * payload 只放摘要与结构化字段（截断后的查询词 / 工具名 / 错误摘要），不复制消息正文——
 * 观测层不持有敏感原文（正文按 sessionId 回查 messages 表）。
 */
export type ObsPayload = Record<string, string | number | boolean | null>;

/** 发布方构造的事件体（bus.ts `type:'obs'` 变体与落库记录共用）。 */
export interface ObsEventBody {
  kind: ObsKind;
  sessionId?: string;
  payload?: ObsPayload;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

/** GET /api/obs/events 响应行（payload 为解析后对象；脏 JSON 容错为 null，不炸整个查询）。 */
export interface ObsEventRow {
  id: number;
  ts: string;
  sessionId: string | null;
  kind: ObsKind;
  payload: ObsPayload | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export function isObsKind(v: unknown): v is ObsKind {
  return typeof v === 'string' && (OBS_KINDS as readonly string[]).includes(v);
}
