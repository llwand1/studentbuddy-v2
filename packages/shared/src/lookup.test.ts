/**
 * lookup：划词速查的取词口径（契约 `docs/LOOKUP-SPEC.md` §3）。
 *
 * 核心是一条**不对称的判断**：`looksLikeTerm` 宁可漏判也不能误判。
 *   漏判（把词当成句）＝ 少一次免费查询，用户仍可点 AI 讲解，代价很小；
 *   误判（把句当成词）＝ 拿一整句去搜百科，必然落空、还白等一个来回；
 *   更糟的是 `pickLookupTerm` 若去"猜"一句话里的关键词，会给出一个**看起来像答案的错条目**——
 *   那比没有答案危险得多。所以猜不出就返回空串，让小窗直接把 AI 讲解摆到前台。
 */
import { describe, expect, it } from 'vitest';
import { LOOKUP_TERM_MAX, LOOKUP_TERM_MAX_CJK, looksLikeTerm, otherWikiLang, pickLookupTerm, wikiLangFor } from './lookup.js';

describe('looksLikeTerm：只看形状，不猜语义', () => {
  it('术语算词：中英文、带空格的词组、带括号的都算', () => {
    for (const s of ['闭包', 'HNSW', '边际效用', 'event loop', 'B+ 树']) expect(looksLikeTerm(s)).toBe(true);
  });

  it('含句读 ⇒ 不是词（这是"是不是一句话"最稳的信号）', () => {
    for (const s of ['它让内层函数记住外层变量。', '先这样，再那样', 'A, then B']) expect(looksLikeTerm(s)).toBe(false);
  });

  it('★ 不含标点的中文短句也不是词（回归锁：单一 40 字上限会把它误判成词）', () => {
    expect('闭包是函数与它词法环境的组合'.length).toBeGreaterThan(LOOKUP_TERM_MAX_CJK);
    expect(looksLikeTerm('闭包是函数与它词法环境的组合')).toBe(false);
    // 真术语仍要放行——上限不能收得过头
    for (const s of ['冯·诺依曼体系结构', '卷积神经网络', '图灵完备性']) expect(looksLikeTerm(s)).toBe(true);
  });

  it('超过上限 ⇒ 不是词；空白 ⇒ 不是词（西文 40 / 中日韩 12 两套上限）', () => {
    expect(looksLikeTerm('x'.repeat(LOOKUP_TERM_MAX))).toBe(true);
    expect(looksLikeTerm('x'.repeat(LOOKUP_TERM_MAX + 1))).toBe(false);
    expect(looksLikeTerm('字'.repeat(LOOKUP_TERM_MAX_CJK))).toBe(true);
    expect(looksLikeTerm('字'.repeat(LOOKUP_TERM_MAX_CJK + 1))).toBe(false);
    expect(looksLikeTerm('   ')).toBe(false);
    expect(looksLikeTerm('')).toBe(false);
  });
});

describe('pickLookupTerm：猜不出就不猜', () => {
  it('是词 ⇒ 原样（折叠空白）', () => {
    expect(pickLookupTerm('  闭包  ')).toBe('闭包');
    expect(pickLookupTerm('event   loop')).toBe('event loop');
  });

  it('是句 ⇒ 空串，绝不从句子里挑一个词去查（错条目比没答案更糟）', () => {
    expect(pickLookupTerm('闭包是函数与它词法环境的组合')).toBe('');
    expect(pickLookupTerm('它让内层函数记住外层变量。')).toBe('');
  });
});

describe('wikiLangFor / otherWikiLang：语种选择与回落', () => {
  it('含 CJK 走中文站，纯西文走英文站', () => {
    expect(wikiLangFor('闭包')).toBe('zh');
    expect(wikiLangFor('ホスト')).toBe('zh');
    expect(wikiLangFor('closure')).toBe('en');
    expect(wikiLangFor('B+ tree')).toBe('en');
  });

  it('回落到另一个语种（很多计算机术语中文站没有、英文站有）', () => {
    expect(otherWikiLang('zh')).toBe('en');
    expect(otherWikiLang('en')).toBe('zh');
  });
});
