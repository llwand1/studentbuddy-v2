/** shared/quiz-tier — 分级推导与文案的单测（契约 docs/QUIZ-TIER-SPEC.md §1）。 */
import { describe, it, expect } from 'vitest';
import { QUIZ_TIER_LABELS, compareTier, countTiers, normalizeQuizRealFirst, tierOf, tierSummaryLine } from './quiz-tier.js';

describe('tierOf（唯一推导口径：显式 tier > source.kind > basic）', () => {
  it('collect → real、web → mock、ai/无 source → basic（历史题不迁移也能标）', () => {
    expect(tierOf({ source: { kind: 'collect', title: 't' } })).toBe('real');
    expect(tierOf({ source: { kind: 'web', title: 't' } })).toBe('mock');
    expect(tierOf({ source: { kind: 'ai', title: 't' } })).toBe('basic');
    expect(tierOf({})).toBe('basic');
  });
  it('服务端已判的显式 tier 优先', () => {
    expect(tierOf({ tier: 'mock', source: { kind: 'collect', title: 't' } })).toBe('mock');
  });
  it('非法 tier 值忽略，退回来源推导', () => {
    expect(tierOf({ tier: 'gold' as never, source: { kind: 'web', title: 't' } })).toBe('mock');
  });
});

describe('排序与计数', () => {
  it('compareTier：real < mock < basic', () => {
    const qs = [{ tier: 'basic' as const }, { tier: 'real' as const }, { tier: 'mock' as const }];
    expect([...qs].sort(compareTier).map((q) => q.tier)).toEqual(['real', 'mock', 'basic']);
  });
  it('countTiers + tierSummaryLine：只列非 0 档', () => {
    const c = countTiers([{ tier: 'real' }, { tier: 'real' }, {}]);
    expect(c).toEqual({ real: 2, mock: 0, basic: 1 });
    expect(tierSummaryLine(c)).toBe('真题 2 · 基础 1');
    expect(tierSummaryLine({ real: 0, mock: 0, basic: 0 })).toBe('');
  });
  it('三档都有中文徽标文案', () => {
    expect(Object.values(QUIZ_TIER_LABELS)).toEqual(['真题·必刷', '模拟题·建议做', '基础题·可选做']);
  });
});

describe('normalizeQuizRealFirst（缺省开）', () => {
  it('布尔/字符串/数字都认，其余回缺省 true', () => {
    expect(normalizeQuizRealFirst(false)).toBe(false);
    expect(normalizeQuizRealFirst('false')).toBe(false);
    expect(normalizeQuizRealFirst(0)).toBe(false);
    expect(normalizeQuizRealFirst(true)).toBe(true);
    expect(normalizeQuizRealFirst(undefined)).toBe(true);
    expect(normalizeQuizRealFirst('garbage')).toBe(true);
  });
});
