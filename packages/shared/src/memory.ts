/**
 * shared/memory — 长期记忆契约（单一事实源，server 与 web 只引用不复制）。
 *
 * 契约全文：`docs/MEMORY-SPEC.md` v1.0。两层机制照搬 Pi 的 Compaction（会话内摘要）
 * 与 AGENTS.md（跨会话注入），**不引向量库、不引新依赖**（MEMORY-SPEC §11.1）。
 *
 * 本文件只放「两侧都要知道的东西」：类别白名单、注入段用的类型、以及所有魔数。
 * 判定逻辑（切点、淘汰、解析）留在 server —— 前端不重算这些。
 */

/**
 * 画像类别白名单。
 * 非法 kind **一律丢弃、不回落成某一类**——猜错的类别比没类别更糟：
 * 一条「薄弱点」被当成「学习偏好」注入，会误导此后所有会话。
 */
export const MEMORY_KINDS = ['profile', 'preference', 'weakness', 'goal'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export function isMemoryKind(v: unknown): v is MemoryKind {
  return typeof v === 'string' && (MEMORY_KINDS as readonly string[]).includes(v);
}

/** 类别中文名（注入段与记忆页共用一份，避免两处各写一套文案）。 */
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  profile: '学习者画像',
  preference: '学习偏好',
  weakness: '薄弱点',
  goal: '学习目标',
};

/** 一条长期记忆。`id` 由服务端生成——模型给的 id 一律忽略（对齐 choice.ts 的 o1/o2 口径）。 */
export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 压缩产出的**待入库**条目（尚未落库，故无 id）。 */
export interface MemoryDraft {
  kind: MemoryKind;
  content: string;
  importance: number;
}

/**
 * 压缩结果。`ok=false` 时 `summary` 恒为 `null` —— 调用方据此决定是否留痕（ADR-5 不静默）。
 * `failure` 区分真因，避免把「模型没配」报成「解析失败」（对齐 quiz 的 failure 拆分口径）。
 */
export interface CompactResult {
  ok: boolean;
  summary: string | null;
  items: MemoryDraft[];
  /** 压缩前被替换掉的上下文 tokens（供 event_log 记账与调参） */
  tokensBefore: number;
  failure?: 'no-model' | 'parse' | 'llm-error';
}

// ── 常量（取值理由见 MEMORY-SPEC §3.3）────────────────────────────────────────

/**
 * 保留最近多少 tokens **不摘要**。
 * 对齐 Pi 默认 `keepRecentTokens=20000`，也等于本仓 `context.ts` 的 `reserveTokens` 量级。
 */
export const COMPACT_KEEP_TOKENS = 20_000;

/**
 * 丢弃量低于此**不调 LLM**——省额度，也避免「摘要比原文还长」这种净亏损。
 * ⚠️ 4000 是估值，落地后按 `event_log` 里 `kind='compact'` 的实际频次校准（MEMORY-SPEC §12）。
 */
export const COMPACT_MIN_DISCARD_TOKENS = 4_000;

/** 摘要段上限：防止模型「摘要」出一篇长文把窗口吃回去。 */
export const SUMMARY_MAX_CHARS = 4_000;

/** 画像条数上限，超出按 `importance` 升序淘汰（淘汰即真删，不做软删）。 */
export const MEMORY_MAX_ITEMS = 50;

/**
 * 画像注入段上限（约 ≤1k tokens）。
 * 画像**恒注入不检索**（画像是「你是谁」，与具体问题无关），故必须硬限长。
 */
export const MEMORY_INJECT_MAX_CHARS = 2_000;

/** 低于此 `importance` 的条目**不注入**（但仍留在库里，记忆页可见可删）。 */
export const MEMORY_MIN_IMPORTANCE = 0.4;

/** 单条画像内容上限（模型偶尔会写一整段，截断而非丢弃）。 */
export const MEMORY_CONTENT_MAX = 200;

// ── 归一 ─────────────────────────────────────────────────────────────────────

/**
 * `importance` 越界 / 非数字 → 回落 `0.5`，**不作废整条**。
 * 与 `normalizeAnswerStyle` 的「逐字段回落，一个非法值不作废整份偏好」同一取向：
 * 宁可少一条精确度，不可丢一条记忆。
 */
export function normalizeImportance(v: unknown): number {
  // ★ 空值（null / undefined / 空白串）是「模型没给这个字段」，**不是**「给了一个很低的分」。
  //   必须回落默认：它们经 Number() 都会变成 0，而 0 会被淘汰且不注入——
  //   等于模型漏写一个字段就悄悄丢掉一条记忆，与「逐字段回落、不作废整条」的取向正好相反。
  //   （实测踩到：`Number(null) === 0`，不是 NaN。）
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return 0.5;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** 内容归一：压平换行、去首尾空白、按 `MEMORY_CONTENT_MAX` 截断。返回空串表示该条应丢弃。 */
export function normalizeMemoryContent(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MEMORY_CONTENT_MAX);
}
