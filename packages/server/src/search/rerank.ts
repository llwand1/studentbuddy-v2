/**
 * search/rerank — L3 精排（契约 WEB-RAG-SPEC §1 L3）。
 *
 * 纯函数 + 一个注入式 embed 口：本文件**不认服务商**（不知道 key/baseUrl/超时），
 * 只回答「给一批已命中的块和它们的向量，怎么重排」。服务商侧在 `llm/embeddings.ts`，
 * 组装在工具层（`chat/tools/research-web.ts`）——三层各管一段，谁也不越界。
 *
 * ★ 为什么精排值得存在（BM25 排不好的那类）：BM25 是**词面**匹配，
 *   问「间隔重复为什么有效」时，含「间隔」「重复」两词的模板页会盖过真正讲**机制**的文章
 *   （后者可能一个查询词都没有，用「分散练习」「遗忘曲线」在说同一件事）。向量余弦认语义，
 *   正好补这条缝——这也是 LiveRAG 类赛题里「hybrid 检索 + 精排」成为标配的原因。
 *
 * ★★ 失败即降级（本文件的核心不变量）：`embed` 返回 `null`（端点不可用/超时/形状不对）
 *   ⇒ **原序原样返回**（= L2 的 BM25 序），`applied: false` + 原因回给调用方如实标注。
 *   绝不抛出、绝不返回半截或乱序结果。
 */
import { WEB_RAG_RERANK_CHARS } from '@sb/shared';
import type { WebRagHit } from './web-rag.js';

/** 余弦相似度。任一向量的模为 0（含空向量/维度不齐）时返回 0——不是 NaN，避免污染排序。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 按查询向量对命中块重排。**纯函数**（同步、无 IO）：给同一批向量恒得同一序——
 * 排序层确定性是它可被回归锁住的前提（同 `doc-retrieve` 的词法路线）。
 * `score` 写回余弦值（与 BM25 不同量纲，仅供展示排序，不参与任何阈值判断）。
 * 同分时按**原 BM25 序**稳定排列（`sort` 稳定性不跨引擎保证，故显式带下标兜底）。
 */
export function rerankByVectors(hits: readonly WebRagHit[], queryVec: readonly number[], docVecs: readonly (readonly number[])[]): WebRagHit[] {
  return hits
    .map((h, i) => ({ h, i, s: cosine(queryVec, docVecs[i] ?? []) }))
    .sort((x, y) => (y.s - x.s) || (x.i - y.i))
    .map((r) => ({ ...r.h, score: r.s }));
}

/** 精排用的向量化口：`[查询, ...块文本]` → 同长向量数组；失败返回 `null`（= 该降级）。 */
export type EmbedFn = (texts: readonly string[]) => Promise<number[][] | null>;

export interface RerankOutcome {
  /** 精排后的命中（`applied: false` 时**就是入参原序**） */
  hits: WebRagHit[];
  applied: boolean;
  /** 降级原因（`applied: true` 时为空），供工具层如实回灌 */
  reason?: string;
}

/**
 * 精排编排：探目标 → 向量化 → 收敛排序。**任何不成立都返回原序 + 原因**，不抛。
 * · 命中 ≤ 1：无"排"可言，直接原序（省一次上游往返）；
 * · 文本先按 `WEB_RAG_RERANK_CHARS` 截：超长块可能整批被上游拒（见 embeddings.ts 注释）。
 */
export async function rerankHits(query: string, hits: readonly WebRagHit[], embed: EmbedFn): Promise<RerankOutcome> {
  if (hits.length <= 1) return { hits: [...hits], applied: false, reason: '候选不足两块' };
  const texts = [query, ...hits.map((h) => h.text.slice(0, WEB_RAG_RERANK_CHARS))];
  let vecs: number[][] | null = null;
  try {
    vecs = await embed(texts);
  } catch {
    vecs = null;
  }
  if (!vecs || vecs.length !== texts.length) {
    return { hits: [...hits], applied: false, reason: 'embedding 不可用' };
  }
  const queryVec = vecs[0];
  if (!queryVec || queryVec.length === 0) return { hits: [...hits], applied: false, reason: 'embedding 不可用' };
  return { hits: rerankByVectors(hits, queryVec, vecs.slice(1)), applied: true };
}