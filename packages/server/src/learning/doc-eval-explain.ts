/**
 * learning/doc-eval-explain — 检索召回的**逐例解释层**（契约 DOC-RAG-SPEC §10.5）。
 *
 * **治的病**：`tools/probes/doc-rag-bm25.mjs` 能报出 `PARA recall 8/13 → 12/13`，但报不出
 * "**为什么**这一条没召回"。没有归因，改参数就只能猜，改对了也不知道是不是巧合。
 * 本层把一个病例拆成可读的东西：命中了哪些词元、各贡献多少分、正确块里**压根没有**哪些词元、
 * 把正确块挤下去的那一块多用了哪些词、以及扩词档里**撤掉哪一个术语**它就会跌出前 k。
 *
 * ★ 全部函数都是**纯函数＋产品口径**：分词走 `tokenizeDoc`（＝`@sb/shared` 的 `tokenizeForFts`），
 *   打分走 `scoreChunks`，索引走 `buildBm25Index`——也就是**产品运行时那一套**，不是探针里的复刻件。
 *   所以本层报出来的解释与线上排序同源；探针那份自实现 BM25 只留作历史读数的出处。
 * ★ 刻意**不重算注入预算**：产品 `retrieveDoc` 里 `takeRanked` 是"k 与字数预算双重截断"，
 *   在评测层复制这条规则＝埋一个"两边口径分叉"的雷。所以"是否真被投进上下文"由调用方
 *   把 `retrieveDoc` 的返回结果当事实传进来（见 `ExplainInput.selectedSeqs`），层里只做归因。
 */
import { scoreChunks, tokenizeDoc } from './doc-retrieve.js';
import type { Bm25Index, DocChunk } from './doc-retrieve.js';

/** 一个查询词元落在某个块上的分量明细。 */
export interface TermHit {
  term: string;
  /** 该词元的逆文本频率（非负形式，见 `buildBm25Index` 注释） */
  idf: number;
  /** 该词元在该块内的词频 */
  tf: number;
  /** 该词元为该块贡献的分数（＝BM25 的可加项，逐词元对账用） */
  contrib: number;
}

/** 病例归因（六选一）。口径写死在这里，避免"每次跑换一个说法解释"。 */
export type MissCause =
  | '命中' // 真进了产品实投的那一组块
  | '答案不在任何块' // 目标事实句被切断／定位不到 ⇒ 与检索无关，是切块或语料问题
  | '零命中' // 正确块存在，但**一个查询词元都不落在里面**
  | '预算截断' // 打分面已进前 k，但被注入字数预算截走 ⇒ 不是检索的锅
  | '词表鸿沟' // **补词反事实可救**：往正确块补进有限几个"教材里已有"的词元就能进前 k ⇒ 扩词/同义映射的地盘
  | '打分竞争'; // 补满候选也进不了前 k（＝差距不在这几个词上，要靠语义信号）⇒ embedding 的地盘，调 k 无用

/** 单个病例的完整解释。 */
export interface CaseExplanation {
  query: string;
  /** 查询侧词元（按出现顺序去重，与 `scoreChunks` 同口径） */
  queryTerms: string[];
  /** 目标块下标；-1＝答案没落进任何块 */
  target: number;
  /** 目标块在**纯打分序**里的名次（1 起）；0＝没出现在打分序里 */
  rank: number;
  /** 产品实投的那一组块里有没有目标块（由调用方传 `retrieveDoc` 的事实） */
  selected: boolean;
  /** 目标块总分（＝`hits` 里 `contrib` 之和） */
  score: number;
  /** 紧压在目标块之上的那**一块**（名次＝目标块名次−1）；null＝它就是第一名或没进打分序 */
  above: { chunkIdx: number; score: number; extraTerms: TermHit[] } | null;
  /** 目标块上的命中词元，按贡献降序 */
  hits: TermHit[];
  /** 查询里有、正确块里没有的词元——**这一列就是"该扩哪个词"的清单** */
  missing: string[];
  /** 把 `missing` 各补一次进正确块的反事实结果（＝"扩词救不救得回"） */
  gapFill: GapFill;
  cause: MissCause;
}

export interface ExplainInput {
  index: Bm25Index;
  chunks: readonly DocChunk[];
  query: string;
  /** 目标（答案）块下标，-1 表示定位失败 */
  target: number;
  /** 产品 `retrieveDoc` 实际返回的块 `seq` 列表（预算与 k 双重截断后的事实） */
  selectedSeqs: number[];
  k: number;
}

/** 查询词元：按出现顺序去重（与 `scoreChunks` 的去重口径一致，重复提问词不双倍加权）。 */
export function dedupQueryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of tokenizeDoc(query)) {
    if (seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
  }
  return terms;
}

/**
 * 把某一块的 BM25 分数拆到**每个命中的查询词元**上，并列出"这块根本没有"的查询词元。
 * 计算式与 `scoreChunks` 逐字同形（同 idf、同 tf、同长度归一化），所以分项之和＝总分，可对账。
 */
export function explainChunkScore(
  index: Bm25Index,
  query: string,
  chunkIdx: number,
): { hits: TermHit[]; missing: string[]; total: number } {
  const hits: TermHit[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const term of dedupQueryTerms(query)) {
    const w = index.idf.get(term);
    const p = index.postings.get(term);
    const j = p ? p.docs.indexOf(chunkIdx) : -1;
    if (!w || !p || j < 0) {
      missing.push(term);
      continue;
    }
    const f = p.tfs[j] ?? 0;
    const dl = index.lens[chunkIdx] ?? 0;
    const denom = f + index.k1 * (1 - index.b + (index.b * dl) / (index.avgdl || 1));
    const contrib = w * ((f * (index.k1 + 1)) / (denom || 1));
    hits.push({ term, idf: w, tf: f, contrib });
    total += contrib;
  }
  hits.sort((a, b) => b.contrib - a.contrib);
  return { hits, missing, total };
}

/**
 * 解释一个病例：名次、分数、逐词元分量、被谁压住、压住它的那一块多用了哪些词、归因。
 *
 * 归因优先级是**从"根本不是检索的锅"往"是检索的锅"排**：
 * 答案没进任何块 → 零命中 → 已进打分前 k 却被注入预算截走 → 补词反事实（可救＝词表鸿沟／不可救＝打分竞争）。
 * 最后这一档用反事实而不是"缺不缺词元"，理由见 {@link GapFill}：bigram 下"缺词元"几乎恒真。
 */
export function explainCase(input: ExplainInput): CaseExplanation {
  const { index, chunks, query, target, selectedSeqs, k } = input;
  const queryTerms = dedupQueryTerms(query);
  const ranked = scoreChunks(index, query);
  const pos = ranked.findIndex((r) => r.i === target);
  const rank = pos >= 0 ? pos + 1 : 0;
  const selected = target >= 0 && selectedSeqs.includes(chunks[target]?.seq ?? -1);
  const base: Omit<CaseExplanation, 'above' | 'hits' | 'missing' | 'score' | 'gapFill' | 'cause'> = {
    query,
    queryTerms,
    target,
    rank,
    selected,
  };
  if (target < 0) {
    return {
      ...base,
      score: 0,
      above: null,
      hits: [],
      missing: queryTerms,
      gapFill: { needed: null, filledScore: 0, rankIfFilled: 0, candidates: [], absent: queryTerms, rescuableByFill: false },
      cause: '答案不在任何块',
    };
  }
  const { hits, missing, total } = explainChunkScore(index, query, target);
  const prev = pos > 0 ? ranked[pos - 1] : undefined;
  let above: CaseExplanation['above'] = null;
  if (prev && prev.i >= 0) {
    // 差集：它凭什么在正确块前面——只看"它有、正确块没有"的那几个词元
    const mine = new Set(hits.map((h) => h.term));
    const theirs = explainChunkScore(index, query, prev.i).hits.filter((h) => !mine.has(h.term));
    above = { chunkIdx: prev.i, score: prev.s, extraTerms: theirs };
  }
  const gapFill = explainGapFill({ index, query, target, k, ranked });
  let cause: MissCause;
  if (selected) cause = '命中';
  else if (hits.length === 0) cause = '零命中';
  else if (rank > 0 && rank <= k) cause = '预算截断';
  else cause = gapFill.rescuableByFill ? '词表鸿沟' : '打分竞争';
  return { ...base, score: total, above, hits, missing, gapFill, cause };
}

/**
 * 「要补几个词才救得回」的反事实——本层最有解释度的一格。
 *
 * ★ 为什么不是"缺不缺词元"，也不是"补满能不能赢"：bigram 分词下改写句总会漏若干词元（实测漏接
 *   病例 9/9 都缺），而把缺的全补进正确块又是 9/9 都能赢——**两个判据都几乎恒真，等于没判**。
 *   有信息量的是**代价**：按最贵的缺失词元先补，补到第几个它才挤进前 k。
 * ★ 口径（保守且单向）：只给正确块加分，每个候选词元假设 tf=1，**其余块的分数一律不变**。
 *   现实里补进来的词会同时抬高分母（df 变大、idf 变小）并给对手加分，所以这里是上界乐观估计——
 *   它回答的是"扩词最多能救到哪"，不是"一定能救到"。
 * ★ **df=0 的缺失词元不进候选**：整篇资料里没出现过的词，扩词（＝把问句改写成教材用词）扩不出它，
 *   那一条属于"要语义信号"的地盘，所以单独列进 `absent` 报出来，而不是按 df=1 的 idf 顶满分救回来——
 *   实测那样会让每条漏接都"一个词就得救"，又变成一个恒真判据。
 */
export interface GapFill {
  /** 进前 k 所需补的词元个数（只算教材里已有的候选）；null＝补满候选也进不了前 k */
  needed: number | null;
  /** 达到 `needed` 时的假想分与名次（needed=null 时为补满候选后的值） */
  filledScore: number;
  rankIfFilled: number;
  /** 先补哪几个（按单项分量降序，最多 5 个），**带 df**：df 只有 1~2 的候选是孤词，只当刻度用 */
  candidates: Array<{ term: string; df: number; gain: number }>;
  /** 教材里一次都没出现的缺失词元（＝扩词救不了，要语义信号） */
  absent: string[];
  /** 补得回来吗（＝needed 非 null） */
  rescuableByFill: boolean;
}

/** 见 {@link GapFill} 的口径说明。`ranked` 传 `scoreChunks` 的结果，省一次重算。 */
export function explainGapFill(args: {
  index: Bm25Index;
  query: string;
  target: number;
  k: number;
  ranked: Array<{ i: number; s: number }>;
}): GapFill {
  const { index, query, target, k, ranked } = args;
  const { missing, total } = explainChunkScore(index, query, target);
  const dl = index.lens[target] ?? 0;
  const denom = 1 + index.k1 * (1 - index.b + (index.b * dl) / (index.avgdl || 1));
  const absent: string[] = [];
  const options: GapFill['candidates'] = [];
  for (const term of missing) {
    const df = index.postings.get(term)?.docs.length ?? 0;
    const w = index.idf.get(term);
    if (df === 0 || !w) {
      absent.push(term);
      continue;
    }
    options.push({ term, df, gain: (w * (index.k1 + 1)) / (denom || 1) });
  }
  options.sort((a, b) => b.gain - a.gain);
  const opponents = ranked.filter((r) => r.i !== target).map((r) => r.s);
  const rankAt = (score: number): number => opponents.filter((s) => s > score).length + 1;
  let filled = total;
  const picked: GapFill['candidates'] = [];
  let needed: number | null = rankAt(filled) <= k ? 0 : null;
  for (let i = 0; needed === null && i < options.length; i++) {
    const o = options[i];
    if (!o) continue;
    filled += o.gain;
    picked.push(o);
    if (rankAt(filled) <= k) needed = i + 1;
  }
  return {
    needed,
    filledScore: filled,
    rankIfFilled: rankAt(filled),
    candidates: picked.slice(0, 5),
    absent,
    rescuableByFill: needed !== null,
  };
}

/** 扩词档里单个术语的归因结果。 */
export interface TermRescue {
  term: string;
  /** 该术语在正确块上的分量（0＝正确块里根本没这个词） */
  contribOnTarget: number;
  /** 从"原话＋全部术语"里撤掉这一个术语后，正确块的名次（0＝跌出打分序） */
  rankWithout: number;
  /** 撤掉它就跌出前 k ⇒ 这一条的召回是它救的 */
  keyRescuer: boolean;
}

/**
 * 扩词归因：**逐个术语撤掉再跑一次**，看正确块还在不在前 k。
 * 为什么不只看分量：BM25 分项大不代表它决定了名次（可能靠别的词也进得来），
 * 反过来说"撤了就出局"才是可证伪的因果。代价是每个术语一次打分（N 次），评测台跑一次几十毫秒级。
 */
export function explainTermRescue(args: {
  index: Bm25Index;
  base: string;
  terms: string[];
  target: number;
  k: number;
}): TermRescue[] {
  const { index, base, terms, target, k } = args;
  return terms.map((term) => {
    const without = [base, ...terms.filter((t) => t !== term)].join(' ');
    const ranked = scoreChunks(index, without);
    const pos = ranked.findIndex((r) => r.i === target);
    const rankWithout = pos >= 0 ? pos + 1 : 0;
    return {
      term,
      contribOnTarget: explainChunkScore(index, term, target).total,
      rankWithout,
      keyRescuer: rankWithout === 0 || rankWithout > k,
    };
  });
}
