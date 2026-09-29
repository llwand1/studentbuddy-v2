/** learning/quiz-tier — 分级落点与真题优先算法的单测（契约 docs/QUIZ-TIER-SPEC.md §2/§4）。零 IO。 */
import { describe, it, expect } from 'vitest';
import type { QuizQuestion } from '@sb/shared';
import { DEFAULT_QUIZ_MIX, MAX_QUIZ_REAL_PER_TYPE } from '@sb/shared';
import { buildTierInstruction, fillTiers, mergeRealFirst, realFirstQuota } from './quiz-tier.js';

const s = (question: string, type: QuizQuestion['type'] = 'single'): QuizQuestion =>
  ({ type, question, options: ['A', 'B'], answer: [0] });

describe('buildTierInstruction', () => {
  it('无参考 ⇒ 基础题写法，禁止杜撰出处；有参考 ⇒ 模拟题写法，要求变式并填 refs', () => {
    expect(buildTierInstruction(false)).toContain('基础题');
    expect(buildTierInstruction(false)).toContain('不要杜撰');
    expect(buildTierInstruction(true)).toContain('模拟题');
    expect(buildTierInstruction(true)).toContain('变式');
  });
});

describe('fillTiers（按来源事实落 tier，模型自报覆盖）', () => {
  it('web → simulated、无 source → basic；模型写的 tier:"real" 不算数', () => {
    const out = fillTiers({
      questions: [
        { ...s('a'), source: { kind: 'web', title: 't', url: 'https://x' } },
        { ...s('b'), tier: 'real' } as QuizQuestion,
      ],
    });
    expect(out.questions.map((q) => q.tier)).toEqual(['simulated', 'basic']);
  });
});

describe('realFirstQuota', () => {
  it('每题型 = AI 配比、scenario 恒 0、封顶 MAX_QUIZ_REAL_PER_TYPE', () => {
    expect(realFirstQuota(DEFAULT_QUIZ_MIX)).toEqual({ single: 2, multiple: 0, fill: 1, essay: 1, judge: 0, scenario: 0 });
    expect(realFirstQuota({ ...DEFAULT_QUIZ_MIX, single: 10, scenario: 3 }).single).toBe(MAX_QUIZ_REAL_PER_TYPE);
    expect(realFirstQuota({ ...DEFAULT_QUIZ_MIX, scenario: 3 }).scenario).toBe(0);
  });
});

describe('mergeRealFirst（真题顶替同题型 AI 题，AI 从后往前削）', () => {
  const ai = [s('s0'), s('s1'), s('f0', 'fill'), s('e0', 'essay')];
  it('一道单选真题 → 削掉 AI 最后一道单选，真题在前，总数不变', () => {
    const r = mergeRealFirst(ai, [{ ...s('R1'), tier: 'real' }]);
    expect(r.questions.map((q) => q.question)).toEqual(['R1', 's0', 'f0', 'e0']);
    expect(r.displaced).toBe(1);
  });
  it('真题题型 AI 侧没有 → 不削任何题、真题照进（只多不少）', () => {
    const r = mergeRealFirst(ai, [s('J1', 'judge')]);
    expect(r.questions).toHaveLength(5);
    expect(r.displaced).toBe(0);
  });
  it('真题多于同型 AI 题 → 只削到 0，不越界', () => {
    const r = mergeRealFirst(ai, [s('R1'), s('R2'), s('R3')]);
    expect(r.questions.map((q) => q.question)).toEqual(['R1', 'R2', 'R3', 'f0', 'e0']);
    expect(r.displaced).toBe(2);
  });
  it('没有真题 → 原样', () => {
    expect(mergeRealFirst(ai, []).questions).toEqual(ai);
  });
});
