/**
 * search/web-rag — 实时检索层：把「搜索摘要 + 现抓正文」当 RAG 语料（契约 WEB-RAG-SPEC §4）。
 *
 * 纯函数、零依赖、不碰网络：切块与打分全部复用 `learning/doc-retrieve.ts` 的既有实现
 * （chunkDoc / buildBm25Index / scoreChunks）——那套阈值是离线探针实测值，这里不另起炉灶。
 *
 * 分级（WEB-RAG-SPEC §1）：
 * · L2 浅深两路：摘要块（snippet）与正文块（page）进**同一个** BM25 索引统一打分合并；
 *   抓到正文的源只放正文块（同 URL 摘要不再进索引——正文是摘要的严格超集，双份只会挤占 Top-K 名额）。
 * · L1/L0 不在本文件：L1 是调用方（research-web 工具）拿本函数结果回灌；L0 是它降级后的摘要直塞。
 */
import { chunkDoc, buildBm25Index, scoreChunks } from '../learning/doc-retrieve.js';
import {
  DOC_CHUNK_CHARS,
  DOC_CHUNK_OVERLAP,
  DOC_INJECT_BUDGET_CHARS,
  DOC_TOP_K,
  WEB_RAG_SNIPPET_CHUNK_CAP,
} from '@sb/shared';

/** 一路检索语料：`origin='page'` 是现抓正文（深路），`'snippet'` 是搜索摘要（浅路兜底）。 */
export interface WebRagSource {
  url: string;
  title: string;
  text: string;
  origin: 'page' | 'snippet';
}

/** 命中的一块：`seq` 是**源内**块号（引用 [n·seq] 的 m 位），`score` 为 BM25 分数。 */
export interface WebRagHit {
  url: string;
  title: string;
  origin: 'page' | 'snippet';
  seq: number;
  text: string;
  score: number;
}

export interface WebRagOpts {
  /** 取几块（默认 DOC_TOP_K=12） */
  k?: number;
  /** 拼接字数天花板（默认 DOC_INJECT_BUDGET_CHARS=12000） */
  budgetChars?: number;
  chunkChars?: number;
  overlap?: number;
}

interface ScoredBlock extends WebRagHit {
  from: number;
  to: number;
}

/** 单源切块：正文走 chunkDoc（800/120 段落聚块）；摘要整条一块、封顶 SNIPPET_CHUNK_CAP。 */
function chunkSource(src: WebRagSource, chunkChars: number, overlap: number): ScoredBlock[] {
  if (src.origin === 'snippet') {
    const text = src.text.slice(0, WEB_RAG_SNIPPET_CHUNK_CAP);
    return text.trim() ? [{ ...src, seq: 1, text, score: 0, from: 0, to: text.length }] : [];
  }
  return chunkDoc(src.text, chunkChars, overlap).map((c) => ({ ...src, seq: c.seq + 1, text: c.text, score: 0, from: c.from, to: c.to }));
}

/**
 * 实时检索：全部源的块进同一个 BM25 索引（浅深两路统一打分），按分数取 Top-K，
 * 受 k 与字数预算双截断（**首块无条件保留**，同 doc-retrieve 的 takeRanked 语义——
 * 否则一个长块就能把整轮检索挤成空注入）。
 *
 * **字面零命中就是空数组，不设任何分数阈值**（DOC-RAG-SPEC §6 的实测结论原样沿用：
 * 绝对阈值在真命中与干扰项之间无分离带；零命中判据交给调用方做 L3 自检降级）。
 * 返回按分数降序；`seq` 从 1 起（对齐 [n·m] 引用的 m 位人读习惯）。
 */
export function retrieveFromSources(query: string, sources: readonly WebRagSource[], opts: WebRagOpts = {}): WebRagHit[] {
  const q = query.trim();
  if (!q || sources.length === 0) return [];
  const blocks = sources.flatMap((s) => chunkSource(s, opts.chunkChars ?? DOC_CHUNK_CHARS, opts.overlap ?? DOC_CHUNK_OVERLAP));
  if (blocks.length === 0) return [];
  // buildBm25Index 只读 DocChunk 的 seq/from/to/text 字段，ScoredBlock 结构子类型兼容。
  const ranked = scoreChunks(buildBm25Index(blocks), q);
  const k = Math.max(1, Math.floor(opts.k ?? DOC_TOP_K));
  const budget = Math.max(1, Math.floor(opts.budgetChars ?? DOC_INJECT_BUDGET_CHARS));
  const out: WebRagHit[] = [];
  let used = 0;
  for (const r of ranked) {
    if (out.length >= k) break;
    const b = blocks[r.i];
    if (!b) continue;
    if (out.length > 0 && used + b.text.length > budget) break;
    out.push({ url: b.url, title: b.title, origin: b.origin, seq: b.seq, text: b.text, score: r.s });
    used += b.text.length;
  }
  return out;
}

/** 命中块拼成给模型的正文：每块带 [n·m] 引用头（n=源编号由调用方传入，m=源内段号）。 */
export function joinWebHits(hits: readonly WebRagHit[], numbers: readonly number[]): string {
  return hits
    .map((h, i) => {
      const n = numbers[i] ?? i + 1;
      return `[${n}·${h.seq}] 来源：${h.url}${h.origin === 'snippet' ? '（摘要）' : ''}\n${h.text}`;
    })
    .join('\n\n');
}
