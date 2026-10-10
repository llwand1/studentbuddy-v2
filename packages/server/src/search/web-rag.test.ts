/**
 * search/web-rag —— 实时检索层回归（契约 WEB-RAG-SPEC §6 T1~T7）。
 *
 * 纯函数零网络：锁的都是「写错不会报错」的事——分级挂错、两路没合进同一索引、
 * 引用编号错位、预算把首块也挤掉（= 整轮检索空注入）。
 */
import { describe, it, expect } from 'vitest';
import { DOC_INJECT_BUDGET_CHARS, DOC_TOP_K } from '@sb/shared';
import { retrieveFromSources, joinWebHits, rankSources, takeRanked } from './web-rag.js';
import type { WebRagSource } from './web-rag.js';

/** 长正文夹具：n 段，只有第 mark 段含 needle（段落间空行分隔，走 chunkDoc 的段落聚块）。 */
function longPage(needle: string, mark: number, paras = 10): string {
  return Array.from({ length: paras }, (_, i) => (i === mark ? `第${i}段：这里讲${needle}的核心机制。` : `第${i}段：无关填充内容，讲的是别的东西。`)).join('\n\n');
}

const PAGE_A: WebRagSource = { url: 'https://a.example/x', title: 'A', text: longPage('间隔重复', 4), origin: 'page' };
const PAGE_B: WebRagSource = { url: 'https://b.example/y', title: 'B', text: longPage('完全无关', 0), origin: 'page' };
const SNIP_C: WebRagSource = { url: 'https://c.example/z', title: 'C', text: '摘要提到间隔重复的实验证据。', origin: 'snippet' };

describe('retrieveFromSources — L1 正文切块检索', () => {
  it('T1 只命中含查询词的源：B 源零块进结果（浅深同索引，分数说了算）', () => {
    const hits = retrieveFromSources('间隔重复', [PAGE_A, PAGE_B]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.url === 'https://a.example/x')).toBe(true);
  });

  it('T2 命中块 seq 从 1 起、带 url/title，且按分数降序', () => {
    const hits = retrieveFromSources('间隔重复', [PAGE_A]);
    const first = hits[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.seq).toBeGreaterThanOrEqual(1);
    expect(first.url).toBe('https://a.example/x');
    for (let i = 1; i < hits.length; i++) expect(hits[i]?.score).toBeLessThanOrEqual(hits[i - 1]?.score ?? 0);
  });

  it('T3 L2 浅深两路：摘要块（snippet）与正文块进同一索引、统一打分', () => {
    const hits = retrieveFromSources('间隔重复', [PAGE_B, SNIP_C]);
    // 正文 B 无查询词 ⇒ 只有摘要块能命中
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.origin === 'snippet')).toBe(true);
  });

  it('T4 L3 自检判据：字面零命中就是空数组（调用方据此降级 L0），不设分数阈值', () => {
    expect(retrieveFromSources('量子纠缠', [PAGE_A, PAGE_B, SNIP_C])).toEqual([]);
  });

  it('T5 预算截尾 + 首块无条件保留：预算 1 字也至少回 1 块（空注入=检索白做）', () => {
    const hits = retrieveFromSources('间隔重复', [PAGE_A], { budgetChars: 1 });
    expect(hits.length).toBe(1);
    const capped = retrieveFromSources('间隔重复', [PAGE_A, { ...PAGE_A, url: 'https://a.example/x2' }], { budgetChars: 900 });
    expect(capped.reduce((s, h) => s + h.text.length, 0)).toBeLessThanOrEqual(900 + 800); // 首块可超预算
  });

  it('T6 空查询 / 空源 → 空数组，不抛异常', () => {
    expect(retrieveFromSources('', [PAGE_A])).toEqual([]);
    expect(retrieveFromSources('间隔重复', [])).toEqual([]);
    expect(retrieveFromSources('   ', [PAGE_A])).toEqual([]);
  });

  it('T7 摘要块封顶 SNIPPET_CHUNK_CAP：异常超长摘要不整条灌进预算', () => {
    const fat: WebRagSource = { url: 'https://c.example/fat', title: 'C', text: '间隔重复'.repeat(4000), origin: 'snippet' };
    const hits = retrieveFromSources('间隔重复', [fat]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.text.length).toBeLessThanOrEqual(600);
  });
});

describe('joinWebHits — [n·m] 引用格式', () => {
  it('编号 n 取调用方传入（与资料面板同号），m 为源内段号；摘要块带（摘要）标注', () => {
    const hits = retrieveFromSources('间隔重复', [PAGE_A, SNIP_C]);
    const out = joinWebHits(hits, [7, 9]);
    expect(out).toContain('[7·');
    expect(out).toContain('来源：https://a.example/x');
    expect(out).toContain('（摘要）'); // snippet 块必须能和正文块区分
  });

  it('numbers 缺省时按 1 起顺序编号', () => {
    const hits = retrieveFromSources('间隔重复', [PAGE_A]);
    expect(joinWebHits(hits, [])).toContain('[1·');
  });
});

describe('rankSources / takeRanked — L3 精排所需的「排序」与「截断」分离', () => {
  /**
   * 每段 ≈726 字（> 半块），段间空行分隔 ⇒ chunkDoc 聚块时**一段一块**，
   * 40 段得 ~40 块 > DOC_TOP_K，才能观察「rankSources 不截断、takeRanked 才截断」。
   * （段写太短会被聚成一块——第一版夹具就踩了这个，T25 当场红。）
   */
  const many: WebRagSource = {
    url: 'https://m.example/m',
    title: 'M',
    text: Array.from({ length: 40 }, (_, i) => `第${i}段：` + '间隔重复相关。'.repeat(120)).join('\n\n'),
    origin: 'page',
  };

  it('T25 rankSources 返回**全部**命中且按分数降序（不截断：精排要看更宽的池）', () => {
    const all = rankSources('间隔重复', [many]);
    expect(all.length).toBeGreaterThan(DOC_TOP_K);
    for (let i = 1; i < all.length; i++) expect(all[i]?.score).toBeLessThanOrEqual(all[i - 1]?.score ?? 0);
  });

  it('T26 takeRanked 按 k 截断，且**首块无条件保留**（预算 1 字也至少回 1 块）', () => {
    const all = rankSources('间隔重复', [many]);
    expect(takeRanked(all, 3, 1_000_000)).toHaveLength(3);
    expect(takeRanked(all, 99, 100_000)).toHaveLength(all.length);
    expect(takeRanked(all, 99, 1)).toHaveLength(1);
  });

  it('T27 L2 等价锁：retrieveFromSources 恒等于 takeRanked(rankSources(...))（拆分不改行为）', () => {
    const viaCombo = takeRanked(rankSources('间隔重复', [many]), DOC_TOP_K, DOC_INJECT_BUDGET_CHARS);
    const viaOld = retrieveFromSources('间隔重复', [many]);
    expect(viaOld.map((h) => h.text)).toEqual(viaCombo.map((h) => h.text));
  });
});
