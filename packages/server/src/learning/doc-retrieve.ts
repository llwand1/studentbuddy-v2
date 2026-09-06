/**
 * learning/doc-retrieve — 文档模式的检索层（契约 DOC-RAG-SPEC §3）。
 *
 * 纯函数、零依赖、不碰 DB 不碰网络：切块 → 中文 bigram 分词 → BM25 倒排打分。
 * 范式沿用 `learning/terms.ts` 的零依赖词法检索（那里是全表扫描打分，这里换成块级倒排索引）。
 *
 * **每轮现算，刻意不缓存**（§3.6）：716k 字资料的索引实测驻留 21.6 MB，而本地长驻服务挂着多个会话；
 * 建索引实测 72ms、单次检索 1.2ms，相对模型秒级往返可忽略。用 72ms 换掉「缓存 + 失效 + 多会话驻留」
 * 三类 bug 是划算的。若日后实测出可感知延迟，那是新决策，不在本文件范围内。
 *
 * 阈值不许改着玩：`DOC_CHUNK_CHARS`/`DOC_TOP_K` 等取值来自离线探针（DOC-RAG-SPEC §8.2），
 * 动它们要重跑探针并同步那份实测记录。
 */
import {
  DOC_CHUNK_CHARS,
  DOC_CHUNK_OVERLAP,
  DOC_INJECT_BUDGET_CHARS,
  DOC_TOP_K,
} from '@sb/shared';
import type { RetrievedChunk } from '@sb/shared';

/** 全文的一块：`seq` 原文顺序号，`from`/`to` 是相对全文的字符偏移。 */
export interface DocChunk {
  seq: number;
  from: number;
  to: number;
  text: string;
}

export interface RetrieveOpts {
  /** 取几块（默认 DOC_TOP_K） */
  k?: number;
  chunkChars?: number;
  overlap?: number;
  /** 拼起来的字数天花板，超出按分数截尾（默认 DOC_INJECT_BUDGET_CHARS） */
  budgetChars?: number;
}

/**
 * 检索器接缝（硬约束 2「向量可插拔」）。本批只落 bm25 一档：
 * embed 档要等 provider 的 `/v1/embeddings` **实测可用**再加（它要真调服务商花额度，至今未实测，见 DOC-RAG-SPEC §8.3），
 * 届时新增一个 `Retriever` 实现并只改 `getRetriever()` 一处，调用方不动。
 */
export interface Retriever {
  readonly kind: 'bm25';
  retrieve: (text: string, query: string, opts?: RetrieveOpts) => RetrievedChunk[];
}

/** CJK 基本区 + 扩展 A + 兼容表意区；单字级匹配，交给 bigram 组合成词 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
/** 英文词与数字（含小数、带点的版本号）——与 terms.ts 的 tokens() 同源思路 */
const LATIN_NUM = /[a-z][a-z0-9.+-]*|\d+(?:\.\d+)?/g;

/**
 * 中英混排分词：英文/数字按词切，中文按连续串切 **bigram**（长度为 1 的串保留单字）。
 * 中文不做真正的分词是刻意的：引分词器就是引依赖，且 bigram 对「一个字之差就换词」的
 * 学习类文本召回更稳（代价是词元数膨胀，由倒排索引 + 查询侧去重消化）。
 */
export function tokenizeDoc(s: string): string[] {
  const low = s.toLowerCase();
  const toks: string[] = low.match(LATIN_NUM) ?? [];
  const cn: string[] = [];
  for (const run of low.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      cn.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) cn.push(run.slice(i, i + 2));
  }
  return cn.length ? toks.concat(cn) : toks;
}

/**
 * 切块：按空行聚段到 `chunkChars`，相邻块带 `overlap` 字重叠防跨块断义。
 * 两条边界必须都覆盖到（T1）：
 * ① 单个段落本身就超阈值（整篇无换行的粘贴件就走这条）→ 按定长硬切，步长 `chunkChars - overlap`；
 * ② `from`/`to` 必须能对回原文，故超长段内用 `indexOf` 把偏移校准到 trim 后的实际起点。
 */
export function chunkDoc(
  text: string,
  chunkChars: number = DOC_CHUNK_CHARS,
  overlap: number = DOC_CHUNK_OVERLAP,
): DocChunk[] {
  const size = Math.max(1, Math.floor(chunkChars));
  const ov = Math.max(0, Math.min(Math.floor(overlap), size - 1));
  const paras: Array<[number, number]> = [];
  const sep = /\n{2,}/g;
  let cursor = 0;
  for (;;) {
    const m = sep.exec(text);
    if (!m) break;
    if (m.index > cursor) paras.push([cursor, m.index]);
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) paras.push([cursor, text.length]);

  const chunks: DocChunk[] = [];
  const push = (from: number, to: number, prefix: string): void => {
    const body = prefix ? `${prefix}\n${text.slice(from, to).trim()}` : text.slice(from, to).trim();
    if (body.trim()) chunks.push({ seq: chunks.length, from, to, text: body });
  };
  let from = -1;
  let to = 0;
  let prefix = '';
  for (const [pf, pt] of paras) {
    const raw = text.slice(pf, pt).trim();
    if (!raw) continue;
    if (raw.length > size) {
      if (from >= 0) {
        push(from, to, prefix);
        from = -1;
        prefix = '';
      }
      const base = text.indexOf(raw, pf);
      const step = size - ov;
      for (let s = 0; s < raw.length; s += step) {
        const e = Math.min(s + step, raw.length);
        chunks.push({ seq: chunks.length, from: base + s, to: base + e, text: raw.slice(s, e) });
        if (e >= raw.length) break;
      }
      continue;
    }
    if (from < 0) {
      from = pf;
      to = pt;
      prefix = '';
      continue;
    }
    if (pt - from > size) {
      const tail = ov > 0 ? text.slice(Math.max(from, to - ov), to) : '';
      push(from, to, prefix);
      from = pf;
      to = pt;
      prefix = tail;
    } else {
      to = pt;
    }
  }
  if (from >= 0) push(from, to, prefix);
  return chunks;
}

/** BM25 倒排索引：`postings` 词元 → (块下标, 词频) 两条等长数组；`lens` 每块词元总数。 */
export interface Bm25Index {
  n: number;
  avgdl: number;
  k1: number;
  b: number;
  lens: number[];
  postings: Map<string, { docs: number[]; tfs: number[] }>;
  idf: Map<string, number>;
}

/**
 * 建索引。`idf` 用非负形式 `ln(1 + (N-df+0.5)/(df+0.5))`——
 * 取经典 `ln((N-df+0.5)/(df+0.5))` 会在 df > N/2 的常见词上出负分，
 * 负分累加能让「命中一堆常见词」的块排到「什么都不命中」之下，那是白送的排序事故。
 */
export function buildBm25Index(chunks: readonly DocChunk[], k1 = 1.2, b = 0.75): Bm25Index {
  const postings = new Map<string, { docs: number[]; tfs: number[] }>();
  const lens: number[] = [];
  chunks.forEach((c, i) => {
    const tf = new Map<string, number>();
    for (const t of tokenizeDoc(c.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let len = 0;
    tf.forEach((f, t) => {
      len += f;
      let p = postings.get(t);
      if (!p) {
        p = { docs: [], tfs: [] };
        postings.set(t, p);
      }
      p.docs.push(i);
      p.tfs.push(f);
    });
    lens.push(len);
  });
  const n = chunks.length;
  const avgdl = n > 0 ? lens.reduce((s, x) => s + x, 0) / n : 0;
  const idf = new Map<string, number>();
  postings.forEach((p, t) => {
    const df = p.docs.length;
    idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  });
  return { n, avgdl, k1, b, lens, postings, idf };
}

/** BM25 打分：只遍历查询词元的倒排链（不是全块扫描），返回按分数降序、且分数 > 0 的块。 */
export function scoreChunks(index: Bm25Index, query: string): Array<{ i: number; s: number }> {
  const acc = new Map<number, number>();
  const seen = new Set<string>();
  for (const t of tokenizeDoc(query)) {
    if (seen.has(t)) continue; // 查询侧按去重词元打分：重复提问词不该双倍加权
    seen.add(t);
    const w = index.idf.get(t);
    const p = index.postings.get(t);
    if (!w || !p) continue;
    for (let j = 0; j < p.docs.length; j++) {
      const d = p.docs[j] ?? -1;
      if (d < 0) continue;
      const f = p.tfs[j] ?? 0;
      const dl = index.lens[d] ?? 0;
      const denom = f + index.k1 * (1 - index.b + (index.b * dl) / (index.avgdl || 1));
      acc.set(d, (acc.get(d) ?? 0) + w * ((f * (index.k1 + 1)) / (denom || 1)));
    }
  }
  return [...acc]
    .map(([i, s]) => ({ i, s }))
    .filter((r) => r.s > 0)
    .sort((x, y) => y.s - x.s);
}

/** 按分数序取块，同时受 k 与字数预算双重截断（预算先耗尽就停，保证注入体量有上界）。 */
function takeRanked(
  chunks: readonly DocChunk[],
  ranked: Array<{ i: number; s: number }>,
  k: number,
  budget: number,
): RetrievedChunk[] {
  const out: RetrievedChunk[] = [];
  let used = 0;
  for (const r of ranked) {
    if (out.length >= k) break;
    const c = chunks[r.i];
    if (!c) continue;
    if (out.length > 0 && used + c.text.length > budget) break; // 首块无条件保留，否则长块资料会一段都注不进去
    out.push({ seq: c.seq, from: c.from, to: c.to, text: c.text, score: r.s });
    used += c.text.length;
  }
  return out;
}

/** 检索：切块 + 建索引 + BM25 Top-K。**返回按分数降序**（不是原文序，段号即相关性序）。 */
export function retrieveDoc(text: string, query: string, opts: RetrieveOpts = {}): RetrievedChunk[] {
  const q = query.trim();
  if (!q) return [];
  const chunks = chunkDoc(text, opts.chunkChars, opts.overlap);
  if (chunks.length === 0) return [];
  const ranked = scoreChunks(buildBm25Index(chunks), q);
  return takeRanked(
    chunks,
    ranked,
    Math.max(1, Math.floor(opts.k ?? DOC_TOP_K)),
    Math.max(1, Math.floor(opts.budgetChars ?? DOC_INJECT_BUDGET_CHARS)),
  );
}

/**
 * 均匀取样：按**位置**横跨全文取 `count` 块，返回原文顺序、`score` 恒 0。
 * 给「没有查询」的批量任务用（词条提取）。刻意不走 BM25——那会把词条抽成"跟某个词最像的那几块"。
 *
 * 预算的算法与检索档不同，这里是**先按预算折算能塞几块、再按这个数均匀铺开**：
 * 若先定 36 块再被预算砍掉尾部，就退化成「只覆盖开头」——正是本函数要治的病（测例已锁）。
 */
export function pickUniformChunks(
  text: string,
  count: number = DOC_TOP_K,
  opts: { chunkChars?: number; overlap?: number; budgetChars?: number } = {},
): RetrievedChunk[] {
  const chunks = chunkDoc(text, opts.chunkChars, opts.overlap);
  if (chunks.length === 0) return [];
  const budget = Math.max(1, Math.floor(opts.budgetChars ?? DOC_INJECT_BUDGET_CHARS));
  const ceiling = Math.min(Math.max(1, Math.floor(count)), chunks.length);
  for (let want = ceiling; want >= 1; want--) {
    const picks = new Set<number>();
    for (let j = 0; j < want; j++) picks.add(Math.round((j * (chunks.length - 1)) / (want - 1 || 1)));
    const chosen = [...picks].sort((a, b) => a - b);
    const used = chosen.reduce((s, i) => s + (chunks[i]?.text.length ?? 0), 0);
    if (used > budget && want > 1) continue;
    const out: RetrievedChunk[] = [];
    for (const i of chosen) {
      const c = chunks[i];
      if (!c) continue;
      out.push({ seq: c.seq, from: c.from, to: c.to, text: c.text, score: 0 });
    }
    return out;
  }
  return [];
}

/** 当前生效的检索器。调用方只该从这里取，别直接认 bm25。 */
export const bm25Retriever: Retriever = { kind: 'bm25', retrieve: retrieveDoc };

export function getRetriever(): Retriever {
  return bm25Retriever;
}

/** 命中块拼成给模型的正文（`withMarks` 时带【段 n】段号，供模型标注引用位置）。 */
export function joinChunks(chunks: readonly RetrievedChunk[], withMarks: boolean): string {
  return chunks.map((c, i) => (withMarks ? `【段 ${i + 1}】${c.text}` : c.text)).join('\n\n');
}
