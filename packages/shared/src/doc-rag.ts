/**
 * @sb/shared — 文档模式检索契约（DOC-RAG-SPEC §3.2）。
 *
 * 常量集中在这里的唯一理由：`DocModeControl.tsx` 曾手抄一份 `INJECT_CAP = 60_000` 并注释
 * 「与服务端 MAX_DOC_CHARS 同值」——那是双真相源，改一处漏一处。shared 不受行数门禁
 * （`tools/gates/check.mjs` 只量 server/web），常量放这里零风险。
 */

/**
 * 整篇直塞阈值：≤ 此字数走今天的全文注入分支（逐字等价 2026-09-02 实现）；超出走检索。
 * 2026-09-06 语义由「截断上限」改为「直塞阈值」，**值不变**（契约 5.0 §5.1.1）。
 */
export const MAX_DOC_CHARS = 60_000;

/** 检索块目标字数。探针依据：938 块规模建索引 72ms、关键词型召回不塌（DOC-RAG-SPEC §8.2） */
export const DOC_CHUNK_CHARS = 800;

/** 相邻块重叠字数（约块长 15%）：防跨块断义。探针实测 overlap=0 时改写型召回下降 */
export const DOC_CHUNK_OVERLAP = 120;

/**
 * Top-K。探针在 716k 字规模扫 k=4/6/8/12/16/24：关键词型恒 13/13，
 * 改写型 5/13（k≤8）→ 8/13（k=12）→ 8/13（k=16、24 不再涨）。12 是拐点，取它。
 */
export const DOC_TOP_K = 12;

/** top-k 拼接的字数天花板，超出按分数截尾。实测 k=12 平均 10.5k，此预算只兜底不常触发 */
export const DOC_INJECT_BUDGET_CHARS = 12_000;

/**
 * 抽词条是**覆盖任务不是相关任务**（它没有查询，拿检索做是概念错误，见 DOC-RAG-SPEC §3.4）：
 * 按位置均匀取样。块数与预算按现有 `extractTerms` 的 30k 输入上限定（36 × 800 ≈ 28.8k），
 * 即同等输入体量下把「只有前 30k」换成「横跨全文的 30k」。
 */
export const DOC_EXTRACT_CHUNKS = 36;
export const DOC_EXTRACT_BUDGET_CHARS = 30_000;

/**
 * 命中的一块资料。`seq` 是原文顺序号（出处定位用），`from`/`to` 是相对全文的字符偏移。
 * `score` 为 BM25 分数；均匀取样档恒为 0（它没有相关性可言）。
 */
export interface RetrievedChunk {
  seq: number;
  from: number;
  to: number;
  text: string;
  score: number;
}
