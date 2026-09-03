/**
 * shared/quiz-mix — 出题配比的纯函数单测（设置页 +/− 的钳位规则住在这里，组件才敢薄）。
 * 钉的是「编辑期钳住」与「落库兜底」的分工：
 *   stepQuizMix 只动目标档位，加不进去就是加不进去，绝不牵连别的题型；
 *   normalizeQuizMix 才会在总题数超限时从后往前削（兜底，不是主路径）。
 * 两者配合的效果：用户在设置页点出来的配比，所见即所存，不会被保存后悄悄改掉。
 */
import { describe, it, expect } from 'vitest';
import type { QuizMix } from './content-blocks.js';
import {
  QUIZ_TYPES,
  DEFAULT_QUIZ_MIX,
  MAX_QUIZ_PER_TYPE,
  MAX_QUIZ_TOTAL,
  mixTotal,
  normalizeQuizMix,
  setQuizMix,
  stepQuizMix,
} from './content-blocks.js';

const mix = (over: Partial<QuizMix> = {}): QuizMix => ({ ...DEFAULT_QUIZ_MIX, ...over });

describe('stepQuizMix（设置页 +/− 编辑态钳位）', () => {
  it('加档：目标档位 +1，其他档位不动', () => {
    expect(stepQuizMix(mix(), 'single', 1)).toEqual({ single: 3, multiple: 0, fill: 1, essay: 1 });
  });

  it('减档：目标档位 −1，其他档位不动', () => {
    expect(stepQuizMix(mix(), 'fill', -1)).toEqual({ single: 2, multiple: 0, fill: 0, essay: 1 });
  });

  it('减到 0 再减仍是 0（不越界成负数）', () => {
    expect(stepQuizMix(mix({ fill: 0 }), 'fill', -1).fill).toBe(0);
  });

  it(`加到单题型上限 ${MAX_QUIZ_PER_TYPE} 停住：不绕回 0，也不削别的档`, () => {
    const at = mix({ single: MAX_QUIZ_PER_TYPE });
    expect(stepQuizMix(at, 'single', 1)).toEqual(at);
  });

  it(`总题数到 ${MAX_QUIZ_TOTAL} 后加不进任何题型，且已有档位一格不动`, () => {
    // 显式写全四档：helper 基于默认配比覆盖，fill/essay 缺省是 1，会凑成 22 题
    const full: QuizMix = { single: MAX_QUIZ_PER_TYPE, multiple: MAX_QUIZ_PER_TYPE, fill: 0, essay: 0 };
    expect(mixTotal(full)).toBe(MAX_QUIZ_TOTAL);
    expect(stepQuizMix(full, 'fill', 1)).toEqual(full);
  });

  it('总满后先减一档，就能加进别的题型（先减后加这条路径要通）', () => {
    const full: QuizMix = { single: MAX_QUIZ_PER_TYPE, multiple: MAX_QUIZ_PER_TYPE, fill: 0, essay: 0 };
    const after = stepQuizMix(stepQuizMix(full, 'multiple', -1), 'fill', 1);
    expect(after.multiple).toBe(MAX_QUIZ_PER_TYPE - 1);
    expect(after.fill).toBe(1);
    expect(mixTotal(after)).toBe(MAX_QUIZ_TOTAL);
  });

  it('一步跨多档时只加到能加的位置（差 2 档到顶却 +5 → 只 +2）', () => {
    expect(stepQuizMix(mix({ single: MAX_QUIZ_PER_TYPE - 2 }), 'single', 5).single).toBe(MAX_QUIZ_PER_TYPE);
  });

  it('一个题型都不放过：四个档位轮番加，各自独立受上限约束', () => {
    let m: QuizMix = mix({ single: 0, multiple: 0, fill: 0, essay: 0 });
    for (const t of QUIZ_TYPES) m = stepQuizMix(m, t, 1);
    expect(m).toEqual({ single: 1, multiple: 1, fill: 1, essay: 1 });
  });

  it('不改入参；delta=0 也返回新副本', () => {
    const src = mix();
    const copy = stepQuizMix(src, 'single', 0);
    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    stepQuizMix(src, 'single', 1);
    expect(src).toEqual(DEFAULT_QUIZ_MIX);
  });
});

describe('setQuizMix（设置页数字直输编辑态钳位）', () => {
  it('直输：目标档位设为输入值，其他档位不动', () => {
    expect(setQuizMix(mix(), 'single', 4)).toEqual({ single: 4, multiple: 0, fill: 1, essay: 1 });
  });

  it('直输 0 = 关掉该题型（每档最少 0 题）', () => {
    expect(setQuizMix(mix(), 'fill', 0).fill).toBe(0);
    expect(setQuizMix(mix(), 'essay', 0)).toEqual({ single: 2, multiple: 0, fill: 1, essay: 0 });
  });

  it('负数直输 → 0；小数取整；非数字 → 0', () => {
    expect(setQuizMix(mix(), 'single', -3).single).toBe(0);
    expect(setQuizMix(mix(), 'single', 3.9).single).toBe(3);
    expect(setQuizMix(mix(), 'single', Number.NaN).single).toBe(0);
  });

  it(`超过单题型上限 ${MAX_QUIZ_PER_TYPE} → 钳到上限`, () => {
    expect(setQuizMix(mix(), 'single', 99).single).toBe(MAX_QUIZ_PER_TYPE);
  });

  it(`总题数超 ${MAX_QUIZ_TOTAL} 时只给到「其他档占用后的剩余额度」，不削别的档`, () => {
    // 全 0 起、其它三档已占 18：fill 直输 10 只能给 2（总额 20），multiple/essay/single 一格不动
    const src: QuizMix = { single: 8, multiple: 10, fill: 0, essay: 0 };
    const after = setQuizMix(src, 'fill', 10);
    expect(after.fill).toBe(2);
    expect(mixTotal(after)).toBe(MAX_QUIZ_TOTAL);
    expect(after.single).toBe(8);
    expect(after.multiple).toBe(10);
  });

  it('全 0 配比下仍可直输单档（0 题起步不锁死）', () => {
    const zero: QuizMix = { single: 0, multiple: 0, fill: 0, essay: 0 };
    expect(setQuizMix(zero, 'single', 3)).toEqual({ single: 3, multiple: 0, fill: 0, essay: 0 });
  });

  it('不改入参；直输后配比仍是合法编辑态（normalize 兜底原样）', () => {
    const src = mix();
    const copy = setQuizMix(src, 'single', 7);
    expect(copy.single).toBe(7);
    expect(src).toEqual(DEFAULT_QUIZ_MIX);
    expect(normalizeQuizMix(copy)).toEqual(copy);
  });
});

describe('stepQuizMix 与 normalizeQuizMix 的分工', () => {
  it('编辑态钳住的配比，落库归一化后原样不变（所见即所存）', () => {
    let m: QuizMix = mix();
    for (let i = 0; i < 50; i++) m = stepQuizMix(m, 'single', 1);
    expect(m.single).toBe(MAX_QUIZ_PER_TYPE);
    expect(normalizeQuizMix(m)).toEqual(m);
  });

  it('总满时四个档位轮流加，都不会被静默削掉别的题型', () => {
    const full: QuizMix = { single: 6, multiple: 6, fill: 4, essay: 4 };
    expect(mixTotal(full)).toBe(MAX_QUIZ_TOTAL);
    let m = full;
    for (const t of QUIZ_TYPES) m = stepQuizMix(m, t, 1);
    expect(m).toEqual(full);
  });

  it('绕过 stepQuizMix 硬造的超限配比，仍由 normalizeQuizMix 兜底削到总上限', () => {
    const over: QuizMix = { single: 10, multiple: 10, fill: 10, essay: 10 };
    const normalized = normalizeQuizMix(over);
    expect(mixTotal(normalized)).toBeLessThanOrEqual(MAX_QUIZ_TOTAL);
  });
});
