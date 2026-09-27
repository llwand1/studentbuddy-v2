/**
 * shared/quiz-source — 出题**来源**配比（真题）的纯函数单测（契约 `docs/QUIZ-BLEND-SPEC.md` §3.2）。
 *
 * 钉的是本契约**唯一的算法变更：联合钳位**。AI 侧与真题侧各自钳在 20 是没有意义的
 * ——用户实际拿到的是**两者之和**，所以「加起来 ≤ 20」必须由这一层保证；
 * 而超限时**削真题侧**（AI 优先保额）：AI 出题是必定成功的路径，真题是尽力而为
 * （摘不到就报缺），反过来会频繁出现「真题没摘到、AI 额度也被挤掉」的双输。
 *
 * 两条**反向锁**（最容易写漏、也最容易在后续重构里被悄悄破坏）：
 *   ① 真题占额之后，AI 侧要真的**加不进去**（只断「AI 侧能加」的话，把 realMix 参数整个删掉仍会全绿）；
 *   ② 省略 `realMix` 时行为与引入本特性**之前逐字一致**（老调用点零改动是「纯加法」纪律的底线）。
 */
import { describe, it, expect } from 'vitest';
import type { QuizMix } from './content-blocks.js';
import {
  DEFAULT_QUIZ_MIX,
  MAX_QUIZ_PER_TYPE,
  MAX_QUIZ_TOTAL,
  mixTotal,
  normalizeQuizMix,
  setQuizMix,
  stepQuizMix,
} from './content-blocks.js';
import type { QuizSourceMix } from './quiz-source.js';
import {
  DEFAULT_QUIZ_SOURCE_MIX,
  MAX_QUIZ_REAL_PER_TYPE,
  blendTotal,
  normalizeQuizSourceMix,
  setQuizSourceMix,
  sourceKindCap,
  sourceMixTotal,
  stepQuizSourceMix,
} from './quiz-source.js';

const ai = (over: Partial<QuizMix> = {}): QuizMix => ({ ...DEFAULT_QUIZ_MIX, ...over });
const real = (over: Partial<QuizSourceMix> = {}): QuizSourceMix => ({ ...DEFAULT_QUIZ_SOURCE_MIX, ...over });
const SCEN = 'scenario' as const;

describe('档位上限与求和', () => {
  it(`真题单题型上限 ${MAX_QUIZ_REAL_PER_TYPE}，比 AI 侧的 ${MAX_QUIZ_PER_TYPE} 更紧`, () => {
    expect(sourceKindCap('single')).toBe(MAX_QUIZ_REAL_PER_TYPE);
    expect(sourceKindCap('essay')).toBe(MAX_QUIZ_REAL_PER_TYPE);
    expect(MAX_QUIZ_REAL_PER_TYPE).toBeLessThan(MAX_QUIZ_PER_TYPE);
  });

  it('情景题真题上限恒 0——情景题是可玩 demo，网上摘不到同类物', () => {
    expect(sourceKindCap(SCEN)).toBe(0);
  });

  it('判断题真题上限恒 0（B2，PK-SPEC §15）——网上规范格式稀少且 AI 零成本可出，判断题只走 AI 侧', () => {
    expect(sourceKindCap('judge')).toBe(0);
  });

  it('sourceMixTotal 逐档求和；blendTotal = AI 侧 + 真题侧', () => {
    const r = real({ single: 2, fill: 1 });
    expect(sourceMixTotal(r)).toBe(3);
    expect(blendTotal(ai(), r)).toBe(mixTotal(ai()) + 3);
  });
});

describe('normalizeQuizSourceMix（落库兜底 + 联合钳位）', () => {
  it('缺省/坏值一律 0，且**不回退默认**——「不出真题」是最常见配置，不是「没配过」', () => {
    expect(normalizeQuizSourceMix(undefined, ai())).toEqual(DEFAULT_QUIZ_SOURCE_MIX);
    expect(normalizeQuizSourceMix({}, ai())).toEqual(DEFAULT_QUIZ_SOURCE_MIX);
    expect(normalizeQuizSourceMix('nonsense', ai())).toEqual(DEFAULT_QUIZ_SOURCE_MIX);
  });

  it('单档超上限钳到上限；负数→0；小数取整', () => {
    const out = normalizeQuizSourceMix({ single: 99, multiple: -3, fill: 2.7 }, ai());
    expect(out.single).toBe(MAX_QUIZ_REAL_PER_TYPE);
    expect(out.multiple).toBe(0);
    expect(out.fill).toBe(2);
  });

  it('情景题无论填几都归 0（不是钳到 3，是这一档根本不存在）', () => {
    expect(normalizeQuizSourceMix({ scenario: 5 }, ai()).scenario).toBe(0);
  });

  it('转不动的值一律 0；数字字符串按数值接受（沿用 normalizeQuizMix 的 Number() 宽松口径）', () => {
    // 沿用既有口径而非自造严格版：前端输入框可能给字符串，`Number()` 能转就认（ADR-6 数据容错）
    expect(normalizeQuizSourceMix({ single: 'abc', multiple: {}, fill: '' }, ai())).toEqual(DEFAULT_QUIZ_SOURCE_MIX);
    expect(normalizeQuizSourceMix({ single: '3' }, ai()).single).toBe(3);
  });

  it(`★ 总量超 ${MAX_QUIZ_TOTAL} 时**削真题侧**，AI 侧一格不动（AI 优先保额）`, () => {
    // AI 侧 18 题 + 真题 5 题 = 23 → 真题被削到 2
    const heavyAi: QuizMix = { single: 10, multiple: 8, fill: 0, essay: 0, judge: 0, scenario: 0 };
    expect(mixTotal(heavyAi)).toBe(18);
    const out = normalizeQuizSourceMix({ single: 5 }, heavyAi);
    expect(sourceMixTotal(out)).toBe(2);
    expect(out.single).toBe(2);
    expect(mixTotal(heavyAi)).toBe(18); // 入参不被改
  });

  it('AI 侧已占满 20 时，真题全部被削成 0（宁可真题 0，也不动 AI 配比）', () => {
    const full: QuizMix = { single: 10, multiple: 10, fill: 0, essay: 0, judge: 0, scenario: 0 };
    expect(mixTotal(full)).toBe(MAX_QUIZ_TOTAL);
    expect(sourceMixTotal(normalizeQuizSourceMix({ single: 3, fill: 2 }, full))).toBe(0);
  });

  it('削真题时从**后往前**（倒档位序：先砍情景/解答，再砍单选）', () => {
    // 需求：single 2 + essay 2 = 4 档真题；只剩 2 的额度 → essay 先被砍光，single 保住
    const room2: QuizMix = { single: 9, multiple: 9, fill: 0, essay: 0, judge: 0, scenario: 0 };
    expect(MAX_QUIZ_TOTAL - mixTotal(room2)).toBe(2);
    const out = normalizeQuizSourceMix({ single: 2, essay: 2 }, room2);
    expect(out.single).toBe(2);
    expect(out.essay).toBe(0);
  });

  it('不越界时原样保留（没超就不该动手）', () => {
    const r = { single: 2, multiple: 0, fill: 1, essay: 0, judge: 0, scenario: 0 };
    expect(normalizeQuizSourceMix(r, ai())).toEqual(r);
  });
});

describe('stepQuizSourceMix（设置页 +/− 编辑态）', () => {
  it('加档：目标档 +1，其余不动', () => {
    expect(stepQuizSourceMix(real(), ai(), 'single', 1).single).toBe(1);
    expect(stepQuizSourceMix(real({ fill: 2 }), ai(), 'single', 1).fill).toBe(2);
  });

  it('减到 0 再减仍是 0（不越界成负数）', () => {
    expect(stepQuizSourceMix(real(), ai(), 'fill', -1).fill).toBe(0);
  });

  it(`加到单档上限 ${MAX_QUIZ_REAL_PER_TYPE} 停住`, () => {
    const at = real({ single: MAX_QUIZ_REAL_PER_TYPE });
    expect(stepQuizSourceMix(at, ai(), 'single', 1)).toEqual(at);
  });

  it('AI 侧 + 真题侧顶到 20 后，真题加不进去（联合钳位）', () => {
    const heavyAi: QuizMix = { single: 10, multiple: 8, fill: 0, essay: 0, judge: 0, scenario: 0 }; // 18
    const r = real({ single: 2 }); // 合计 20
    expect(blendTotal(heavyAi, r)).toBe(MAX_QUIZ_TOTAL);
    expect(stepQuizSourceMix(r, heavyAi, 'fill', 1)).toEqual(r);
  });

  it('一步跨多档只加到能加的位置（差 1 档却 +5 → 只 +1）', () => {
    const heavyAi: QuizMix = { single: 10, multiple: 8, fill: 0, essay: 0, judge: 0, scenario: 0 };
    expect(stepQuizSourceMix(real({ single: 1 }), heavyAi, 'single', 5).single).toBe(2);
  });

  it('情景档加不进去（上限恒 0）', () => {
    expect(stepQuizSourceMix(real(), ai(), SCEN, 1).scenario).toBe(0);
  });
});

describe('setQuizSourceMix（设置页数字直输）', () => {
  it('正常设值', () => {
    expect(setQuizSourceMix(real(), ai(), 'single', 3).single).toBe(3);
  });

  it('超单档上限收口到上限；负数/非数字 → 0', () => {
    expect(setQuizSourceMix(real(), ai(), 'single', 99).single).toBe(MAX_QUIZ_REAL_PER_TYPE);
    expect(setQuizSourceMix(real({ single: 3 }), ai(), 'single', -5).single).toBe(0);
    expect(setQuizSourceMix(real({ single: 3 }), ai(), 'single', Number.NaN).single).toBe(0);
  });

  it('顶破总上限时只给到剩余额度，**不牵连别的真题档**', () => {
    const heavyAi: QuizMix = { single: 10, multiple: 8, fill: 0, essay: 0, judge: 0, scenario: 0 }; // 18
    // 剩余 2；已配 fill 1 → 再给 single 填 9 只能拿到 1（且 fill 保持 1）
    const out = setQuizSourceMix(real({ fill: 1 }), heavyAi, 'single', 9);
    expect(out.single).toBe(1);
    expect(out.fill).toBe(1);
    expect(blendTotal(heavyAi, out)).toBe(MAX_QUIZ_TOTAL);
  });

  it('AI 侧占满时直输任何值都得 0', () => {
    const full: QuizMix = { single: 10, multiple: 10, fill: 0, essay: 0, judge: 0, scenario: 0 };
    expect(setQuizSourceMix(real(), full, 'single', 3).single).toBe(0);
  });
});

describe('★ 方向锁：真题占额会挤压 AI 侧（联合钳位的另一半）', () => {
  it('AI 侧加档要扣掉真题已占的额度', () => {
    const nearFull: QuizMix = { single: 10, multiple: 8, fill: 0, essay: 0, judge: 0, scenario: 0 }; // 18
    const r = real({ single: 2 }); // 合计 20
    expect(stepQuizMix(nearFull, 'fill', 1, r)).toEqual(nearFull); // 加不进
    expect(setQuizMix(nearFull, 'fill', 1, r).fill).toBe(0);
  });

  it('真题没占额时，AI 侧的加档空间与不传 realMix 完全相同', () => {
    const base = ai({ single: 10, multiple: 9 });
    expect(stepQuizMix(base, 'fill', 1, real())).toEqual(stepQuizMix(base, 'fill', 1));
  });
});

describe('★ 向后兼容锁：省略 realMix 时行为与引入本特性之前逐字一致', () => {
  it('stepQuizMix 三参调用不受影响', () => {
    expect(stepQuizMix(ai(), 'single', 1)).toEqual({ single: 3, multiple: 0, fill: 1, essay: 1, judge: 0, scenario: 0 });
  });

  it('setQuizMix 三参调用不受影响', () => {
    expect(setQuizMix(ai(), 'multiple', 4).multiple).toBe(4);
  });

  it('normalizeQuizMix 单参调用：全 0 仍回退默认（老语义没被"纯真题组例外"改掉）', () => {
    expect(normalizeQuizMix({ single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 })).toEqual(DEFAULT_QUIZ_MIX);
  });
});

describe('★ 纯真题组合法（normalizeQuizMix 的 realMix 例外）', () => {
  it('AI 侧全 0 且真题侧有题 → 保留 AI 全 0，**不回退默认**（用户就要这一套全真题）', () => {
    const out = normalizeQuizMix({ single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 }, real({ single: 3 }));
    expect(mixTotal(out)).toBe(0);
  });

  it('AI 侧全 0 且真题侧也全 0 → 照旧回退默认（一套 0 题的题组没有意义）', () => {
    const out = normalizeQuizMix({ single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 }, real());
    expect(out).toEqual(DEFAULT_QUIZ_MIX);
  });
});
