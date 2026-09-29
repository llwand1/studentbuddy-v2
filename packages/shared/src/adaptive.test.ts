/**
 * adaptive — 能力估计与难度档：锁方向性与目标区间，不锁具体小数。
 */
import { describe, it, expect } from 'vitest';
import { ADAPTIVE_MIN_N, ADAPTIVE_TARGET, difficultyInstruction, estimateAbility, expectedCorrect, levelFor } from './adaptive.js';

const many = (n: number, correct: (i: number) => boolean, qtype = 'choice') => Array.from({ length: n }, (_, i) => ({ qtype, correct: correct(i) }));

describe('estimateAbility', () => {
  it(`样本不足 ${ADAPTIVE_MIN_N} 题 ⇒ 不给档位，提示词段为空`, () => {
    const e = estimateAbility(many(ADAPTIVE_MIN_N - 1, () => true));
    expect(e.level).toBeNull();
    expect(difficultyInstruction(e)).toBe('');
  });
  it('★ 全对的人能力高于全错的人，建议档位更难', () => {
    const hi = estimateAbility(many(30, () => true));
    const lo = estimateAbility(many(30, () => false));
    expect(hi.theta).toBeGreaterThan(lo.theta);
    expect(['进阶', '挑战']).toContain(hi.level);
    expect(['入门', '基础']).toContain(lo.level);
  });
  it('★ 建议难度正好让他答对约 77.5%', () => {
    const e = estimateAbility(many(40, (i) => i % 3 !== 0));
    expect(expectedCorrect(e.theta, e.targetB!)).toBeCloseTo(ADAPTIVE_TARGET, 1);
  });
  it('★ 同样答对，难题（解答）比易题（判断）说明能力更高', () => {
    expect(estimateAbility(many(20, () => true, 'short')).theta).toBeGreaterThan(estimateAbility(many(20, () => true, 'judge')).theta);
  });
  it('近 20 题正确率；能力钳在 ±4', () => {
    const e = estimateAbility([...many(30, () => false), ...many(20, () => true)]);
    expect(e.recentAccuracy).toBe(1);
    expect(Math.abs(estimateAbility(many(500, () => true)).theta)).toBeLessThanOrEqual(4);
  });
});

describe('档位与提示词', () => {
  it('档位边界单调', () => {
    expect([-2, -0.5, 0, 1, 2].map(levelFor)).toEqual(['入门', '基础', '标准', '进阶', '挑战']);
  });
  it('提示词带档位、说明与正确率', () => {
    const t = difficultyInstruction(estimateAbility(many(20, (i) => i % 2 === 0)));
    expect(t).toMatch(/「(入门|基础|标准|进阶|挑战)」档/);
    expect(t).toContain('近期正确率约 50%');
    expect(t).toContain('七到八成');
  });
});
