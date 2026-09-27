/**
 * learning/doc-eval-explain 单测（契约 DOC-RAG-SPEC §10.5）。
 *
 * 纯函数、不碰 DB 不碰网络。锁的是**解释与产品打分同源**这一条命——解释层一旦与 `scoreChunks`
 * 分叉，评测台报的"为什么没召回"就全是编的，而它看起来很像真的。
 * ★ 语料用**手摆的 DocChunk**（不走 `chunkDoc`）：这层要锁的是"解释对不对得上索引"，
 *   把切块掺进来只会让用例难算；切块本身由 `doc-retrieve.test.ts` 的 T1~T5 锁。
 * ★ 词元刻意用**空格隔开的单个词**（`alpha`/`delta`…）：中文 bigram 会让"该补哪个词"变得要心算。
 */
import { describe, it, expect } from 'vitest';
import { buildBm25Index, retrieveDoc, scoreChunks } from './doc-retrieve.js';
import type { DocChunk } from './doc-retrieve.js';
import { dedupQueryTerms, explainCase, explainChunkScore, explainGapFill, explainTermRescue } from './doc-eval-explain.js';

const mk = (texts: string[]): DocChunk[] => texts.map((t, i) => ({ seq: i, from: 0, to: 0, text: t }));

/** 通用小索引：T 是"答案块"，O 是"压住它的那一块"。 */
function fixture(query: string, texts: string[]): { index: ReturnType<typeof buildBm25Index>; chunks: DocChunk[]; ranked: Array<{ i: number; s: number }> } {
  const chunks = mk(texts);
  const index = buildBm25Index(chunks);
  return { index, chunks, ranked: scoreChunks(index, query) };
}

describe('dedupQueryTerms 查询词元', () => {
  it('按出现顺序去重，与 scoreChunks 同口径（重复提问词不双倍加权）', () => {
    expect(dedupQueryTerms('alpha beta alpha alpha')).toEqual(['alpha', 'beta']);
  });
});

describe('explainChunkScore 分项对账', () => {
  const texts = ['alpha delta delta', 'alpha alpha alpha alpha', 'beta gamma', 'delta beta gamma gamma gamma'];
  const queries = ['alpha', 'alpha delta', 'beta gamma delta', 'zzz alpha', 'alpha delta beta gamma'];

  it('★ 分项之和＝scoreChunks 的总分（逐查询逐块，解释层不许和打分层分叉）', () => {
    for (const q of queries) {
      const { index, chunks, ranked } = fixture(q, texts);
      for (const r of ranked) {
        const { total } = explainChunkScore(index, q, r.i);
        expect(total, `query=${q} chunk=${r.i}`).toBeCloseTo(r.s, 10);
      }
      expect(chunks).toHaveLength(texts.length);
    }
  });

  it('命中集与缺失集不相交，并起来正好是查询词元全集', () => {
    const q = 'alpha delta zzz';
    const { index } = fixture(q, texts);
    const terms = dedupQueryTerms(q);
    for (let i = 0; i < texts.length; i++) {
      const { hits, missing } = explainChunkScore(index, q, i);
      const hitTerms = hits.map((h) => h.term);
      expect([...missing].sort()).toEqual(terms.filter((t) => !hitTerms.includes(t)).sort());
      expect(new Set(hitTerms).size).toBe(hitTerms.length); // 去重后不该有重复项
    }
  });

  it('每个分项都能用 BM25 原式手算复现（idf、tf、长度归一化三项都取自索引）', () => {
    const q = 'alpha delta';
    const { index } = fixture(q, texts);
    const { hits } = explainChunkScore(index, q, 0); // 块 0 = 'alpha delta delta'
    const alpha = hits.find((h) => h.term === 'alpha');
    expect(alpha?.tf).toBe(1);
    expect(alpha?.idf).toBeCloseTo(Math.log(1 + (4 - 2 + 0.5) / (2 + 0.5)), 10); // df(alpha)=2, N=4
    const denom = alpha ? 1 + index.k1 * (1 - index.b + (index.b * (index.lens[0] ?? 0)) / index.avgdl) : 1;
    expect(alpha?.contrib).toBeCloseTo((alpha?.idf ?? 0) * ((alpha?.tf ?? 0) * (index.k1 + 1)) / denom, 10);
  });
});

describe('explainCase 六类归因（口径写死，不许每次换一个说法）', () => {
  const texts = ['alpha', 'alpha alpha alpha alpha', 'delta', 'beta gamma'];

  it('命中：进了调用方传进来的实投集合', () => {
    const { index, chunks } = fixture('alpha', texts);
    const e = explainCase({ index, chunks, query: 'alpha delta', target: 2, selectedSeqs: [2, 0], k: 2 });
    expect(e.cause).toBe('命中');
    expect(e.selected).toBe(true);
  });

  it('答案不在任何块：target=-1，且 missing 就是查询词元全集', () => {
    const { index, chunks } = fixture('alpha delta', texts);
    const e = explainCase({ index, chunks, query: 'alpha delta', target: -1, selectedSeqs: [], k: 2 });
    expect(e.cause).toBe('答案不在任何块');
    expect(e.missing).toEqual(dedupQueryTerms('alpha delta'));
  });

  it('零命中：正确块存在，但一个查询词元都不落在里面', () => {
    const { index, chunks } = fixture('zzzqqq', texts);
    const e = explainCase({ index, chunks, query: 'zzzqqq', target: 2, selectedSeqs: [], k: 2 });
    expect(e.hits).toHaveLength(0);
    expect(e.rank).toBe(0); // 没进打分序
    expect(e.cause).toBe('零命中');
  });

  it('预算截断：名次已在前 k，却没出现在实投集合里（＝锅在注入预算，不在检索）', () => {
    const { index, chunks } = fixture('alpha', texts);
    const e = explainCase({ index, chunks, query: 'alpha', target: 0, selectedSeqs: [], k: 3 });
    expect(e.rank).toBeGreaterThan(0);
    expect(e.rank).toBeLessThanOrEqual(3);
    expect(e.cause).toBe('预算截断');
  });

  it('词表鸿沟：正确块缺的词元**教材里有**，补进去就能翻盘', () => {
    // 块 0=目标（只有 alpha，df=2 ⇒ idf 低）；块 2=只有 delta（df=1 ⇒ idf 最高）
    const q = 'alpha delta';
    const { index, chunks } = fixture(q, texts);
    const e = explainCase({ index, chunks, query: q, target: 0, selectedSeqs: [], k: 1 });
    // 打分序 = [2(delta，idf 顶), 1(alpha×4，tf 顶), 0(目标，alpha 只出现 1 次)] ⇒ 目标排第 3
    expect(e.rank).toBe(3);
    expect(e.above?.chunkIdx).toBe(1); // ★ 紧压它的是前一格，不是榜首榜首
    expect(e.gapFill.absent).toEqual([]); // 缺的 delta 教材里有
    expect(e.gapFill.candidates.map((c) => c.term)).toEqual(['delta']);
    expect(e.gapFill.needed).toBe(1);
    expect(e.cause).toBe('词表鸿沟');
  });

  it('打分竞争：缺的词元整篇教材都没出现（df=0），补无可补 ⇒ 不是扩词的地盘', () => {
    // 目标块 0 'alpha' 被块 1 'alpha×4' 用 tf 压住；查询里另一个词 zzz 全库没有
    const q = 'alpha zzz';
    const { index, chunks } = fixture(q, texts);
    const e = explainCase({ index, chunks, query: q, target: 0, selectedSeqs: [], k: 1 });
    expect(e.hits).toHaveLength(1); // 不是零命中
    expect(e.gapFill.absent).toContain('zzz');
    expect(e.gapFill.candidates).toHaveLength(0);
    expect(e.gapFill.needed).toBe(null);
    expect(e.cause).toBe('打分竞争');
  });
});

describe('explainGapFill 补词反事实（乐观上界的口径锁）', () => {
  const texts = ['alpha', 'alpha alpha alpha alpha', 'delta', 'beta gamma'];

  it('只给正确块加分，对手一律不动 ⇒ 假想分必然 ≥ 现分、假想名次必然 ≤ 现名次', () => {
    const q = 'alpha delta beta';
    const { index, ranked } = fixture(q, texts);
    const g = explainGapFill({ index, query: q, target: 0, k: 1, ranked });
    const cur = ranked.find((r) => r.i === 0)?.s ?? 0;
    const rankNow = ranked.findIndex((r) => r.i === 0) + 1;
    expect(g.filledScore).toBeGreaterThanOrEqual(cur);
    expect(g.rankIfFilled).toBeLessThanOrEqual(rankNow);
  });

  it('needed 是"按分量降序贪心"的最小前缀：多补一个不该变差，少补一个不该进前 k', () => {
    const q = 'alpha delta';
    const { index, ranked } = fixture(q, texts);
    const g = explainGapFill({ index, query: q, target: 0, k: 1, ranked });
    expect(g.needed).toBe(1);
    expect(g.candidates[0]?.term).toBe('delta');
    expect(g.candidates[0]?.df).toBe(1);
  });

  it('教材里没出现过的词元（df=0）不进候选——否则每条漏接都"一个词就得救"，判据又变恒真', () => {
    const q = 'alpha zzz';
    const { index, ranked } = fixture(q, texts);
    const g = explainGapFill({ index, query: q, target: 0, k: 1, ranked });
    expect(g.candidates).toHaveLength(0);
    expect(g.absent).toEqual(['zzz']);
    expect(g.rescuableByFill).toBe(false);
  });

  it('k 放宽 ⇒ 同一个病例的 needed 只会变小或不变（单调，不许反着来）', () => {
    const q = 'alpha delta beta';
    const { index, ranked } = fixture(q, texts);
    const strict = explainGapFill({ index, query: q, target: 0, k: 1, ranked });
    const loose = explainGapFill({ index, query: q, target: 0, k: 3, ranked });
    if (strict.needed !== null && loose.needed !== null) expect(loose.needed).toBeLessThanOrEqual(strict.needed);
    if (loose.needed === null) expect(strict.needed).toBe(null); // 松的都救不回，紧的更救不回
  });
});

describe('explainTermRescue 撤词反事实（可证伪的因果，不是分量）', () => {
  it('撤掉 delta 目标块就跌出前 1 ⇒ 这一条的召回是它救的；k=2 时又"谁撤都在"', () => {
    const chunks = mk(['alpha delta', 'alpha alpha alpha alpha', 'beta gamma']);
    const index = buildBm25Index(chunks);
    const one = explainTermRescue({ index, base: 'alpha', terms: ['delta'], target: 0, k: 1 });
    expect(one[0]?.rankWithout).toBe(2);
    expect(one[0]?.keyRescuer).toBe(true);
    const two = explainTermRescue({ index, base: 'alpha', terms: ['delta'], target: 0, k: 2 });
    expect(two[0]?.keyRescuer).toBe(false);
  });

  it('术语串里跟教材无关的词：分量为 0，撤掉也不影响名次（＝白扩的词该被看见）', () => {
    const chunks = mk(['alpha delta', 'beta gamma']);
    const index = buildBm25Index(chunks);
    const r = explainTermRescue({ index, base: 'alpha', terms: ['zzzq'], target: 0, k: 1 });
    expect(r[0]?.contribOnTarget).toBe(0);
    expect(r[0]?.keyRescuer).toBe(false);
  });
});

describe('解释层与产品检索同序（评测台读的名次＝线上排序）', () => {
  it('小文档不触发注入预算时，retrieveDoc 的段序与解释层的打分序一致', () => {
    const doc = ['alpha delta 月球的重力', 'beta gamma 无关段落', 'alpha alpha alpha 竞争段落'].join('\n\n');
    const chunks = mk(doc.split('\n\n'));
    const index = buildBm25Index(chunks);
    const q = 'alpha delta';
    const picked = retrieveDoc(doc, q, { k: 3, chunkChars: 200, overlap: 0, budgetChars: 5000 });
    const ranked = scoreChunks(index, q).map((r) => r.i);
    expect(picked.map((p) => p.seq)).toEqual(ranked.slice(0, picked.length));
    const e = explainCase({ index, chunks, query: q, target: 0, selectedSeqs: picked.map((p) => p.seq), k: 3 });
    expect(e.rank).toBe(1);
    expect(e.selected).toBe(true);
  });

  it('目标块没被实投时，解释层的 selected 必须跟着调用方给的事实走（层里不许自己重算预算）', () => {
    const chunks = mk(['alpha delta', 'beta gamma']);
    const index = buildBm25Index(chunks);
    const e = explainCase({ index, chunks, query: 'alpha delta', target: 0, selectedSeqs: [1], k: 3 });
    expect(e.rank).toBe(1); // 打分面它是第一
    expect(e.selected).toBe(false); // 但实投里没有它
    expect(e.cause).toBe('预算截断');
  });
});
