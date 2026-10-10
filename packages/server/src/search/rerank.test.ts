/**
 * search/rerank —— L3 精排回归（契约 WEB-RAG-SPEC §6 T14~T20）。
 *
 * 纯函数零网络：锁的核心是**「失败即降级」这条不变量**——精排是可选增强，
 * 它坏了绝不能污染主线（改序、抛错、返回半截）。另锁「精排真能纠 BM25 的错」这条价值主张。
 */
import { describe, it, expect, vi } from 'vitest';
import { cosine, rerankByVectors, rerankHits } from './rerank.js';
import type { WebRagHit } from './web-rag.js';

function hit(text: string, score = 1, url = 'https://a.example/x'): WebRagHit {
  return { url, title: 't', origin: 'page', seq: 1, text, score };
}

describe('cosine — 余弦相似度（精排的打分量）', () => {
  it('T14 同向=1、正交=0、零向量=0（**不是 NaN**——NaN 会污染整个排序）', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([], [1, 1])).toBe(0);
    expect(Number.isNaN(cosine([0, 0], [0, 0]))).toBe(false);
  });

  it('T15 长度不齐按短的对齐算（上游偶尔多回一维，不该因此整批作废）', () => {
    expect(cosine([1, 1], [1, 1, 99])).toBeCloseTo(1, 10);
  });
});

describe('rerankByVectors — 向量重排（纯函数、确定性）', () => {
  it('T16 按余弦降序重排，且 score 写回余弦值', () => {
    const hits = [hit('A'), hit('B'), hit('C')];
    // 查询向量与 B 最接近，其次 C，A 最远
    const out = rerankByVectors(hits, [1, 0], [[0, 1], [1, 0], [0.7, 0.3]]);
    expect(out.map((h) => h.text)).toEqual(['B', 'C', 'A']);
    expect(out[0]?.score).toBeCloseTo(1, 6);
    expect(out[2]?.score).toBeCloseTo(0, 6);
  });

  it('T17 同分按**原 BM25 序**稳定排列（不靠 sort 的跨引擎稳定性，显式带下标兜底）', () => {
    const hits = [hit('first'), hit('second'), hit('third')];
    const out = rerankByVectors(hits, [1, 0], [[0, 1], [0, 1], [0, 1]]); // 全 0 分
    expect(out.map((h) => h.text)).toEqual(['first', 'second', 'third']);
  });

  it('T18 缺向量的块按 0 分参与排序，不被丢弃（宁可排后，不可静默丢块）', () => {
    const hits = [hit('has'), hit('missing')];
    const out = rerankByVectors(hits, [1, 0], [[1, 0]]);
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBe('has');
    expect(out[1]?.text).toBe('missing');
  });
});

describe('rerankHits — 编排与**失败即降级**（本文件的核心不变量）', () => {
  it('T19 精排生效：applied=true，B 被提到 A 前（补 BM25 的词面短板）', async () => {
    const hits = [hit('模板页：间隔重复间隔重复', 9), hit('分散练习为何有效', 2)];
    const embed = vi.fn(async () => [
      [1, 0], // 查询「为什么有效」≈ 语义向量
      [0, 1], // A 词面高分但与查询语义远
      [0.98, 0.02], // B 词面低分但语义近
    ]);
    const out = await rerankHits('间隔重复为什么有效', hits, embed);
    expect(out.applied).toBe(true);
    expect(out.hits.map((h) => h.text)).toEqual(['分散练习为何有效', '模板页：间隔重复间隔重复']);
  });

  it('T20 embed 返回 null → **原序原样**返回 + applied=false + 原因（绝不改序）', async () => {
    const hits = [hit('A', 9), hit('B', 2)];
    const out = await rerankHits('q', hits, async () => null);
    expect(out.applied).toBe(false);
    expect(out.hits.map((h) => h.text)).toEqual(['A', 'B']);
    expect(out.reason).toBe('embedding 不可用');
  });

  it('T21 embed 抛异常 → 同样降级（**不向上抛**，主线不受影响）', async () => {
    const hits = [hit('A', 9), hit('B', 2)];
    const out = await rerankHits('q', hits, async () => {
      throw new Error('boom');
    });
    expect(out.applied).toBe(false);
    expect(out.hits.map((h) => h.text)).toEqual(['A', 'B']);
  });

  it('T22 返回向量条数不匹配 → 降级（宁可不精排，也不要错位的序）', async () => {
    const hits = [hit('A'), hit('B')];
    const out = await rerankHits('q', hits, async () => [[1, 0]]); // 期望 3 条（查询+2块）
    expect(out.applied).toBe(false);
  });

  it('T23 候选 ≤1 块：无"排"可言，直接原序且**一次 embedding 都不调**', async () => {
    const embed = vi.fn(async () => [[1, 0], [1, 0]]);
    const out = await rerankHits('q', [hit('only')], embed);
    expect(out.applied).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });

  it('T24 喂 embedding 的块先按 WEB_RAG_RERANK_CHARS 截（超长块可能整批被上游拒）', async () => {
    const long = 'x'.repeat(5000);
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]));
    await rerankHits('q', [hit(long), hit('short')], embed);
    const sent = embed.mock.calls[0]?.[0] as string[];
    expect(sent[0]).toBe('q');
    expect(sent[1]?.length).toBeLessThanOrEqual(1200);
  });
});