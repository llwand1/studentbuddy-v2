/**
 * shared/quiz-judge —— 判分唯一事实源的用例（issue #56，2026-09-27）。
 *
 * ★ 本文件最该锁的**不是**"答对返回 true"，而是三条会让人**统计出口说谎**的形状：
 *  ① **`judge` 与 `single`/`multiple` 同路**（判据 `isChoiceQuestion`）。
 *     这不是一条装饰用例：2026-09-20 加判断题（`5249614`，PK-SPEC §15 B2）时
 *     `content-blocks.ts:31` 就写了"一切按选项判分的链路零特判"，而聊天题卡
 *     （`QuizCard.tsx`）的选项渲染与判分**两处都只写了 `single｜multiple`** ⇒
 *     设置页把判断题配进配比之后，那类卡在界面上根本没有可点的选项。
 *     本条用例是给"零特判"这句**第一次**补上的兑现证据。
 *  ② **`null`（不判）不许塌成 `false`**。开放题免检、题面缺答案钥匙、作答形状不合
 *     这三种都进不了流水；一旦其中任何一种被算成"答错"，正确率就被假负样本灌低，
 *     而这种偏差**在统计上看不出来**（它长得就像"这人真不会"）。
 *  ③ **多选乱序通过、部分正确不通过**。前者是用户直觉（勾 A 勾 C 与勾 C 勾 A 是同一个答案），
 *     后者是口径（一旦给部分分就要选阈值，而阈值进了流水再也解释不清）。
 */
import { describe, it, expect } from 'vitest';
import { isChoiceQuestion, judgeQuizAnswer } from './quiz-judge.js';
import { QUIZ_TYPES, type QuizQuestion } from './content-blocks.js';

const q = (over: Partial<QuizQuestion> & { type: QuizQuestion['type'] }): QuizQuestion => ({ question: '题干', ...over });

describe('isChoiceQuestion —— "按选项判分"的判据只有一份', () => {
  it('single / multiple / judge 是选项题', () => {
    expect(isChoiceQuestion(q({ type: 'single' }))).toBe(true);
    expect(isChoiceQuestion(q({ type: 'multiple' }))).toBe(true);
    // ★ 这条是 ①：`judge` 必须在 true 这一侧
    expect(isChoiceQuestion(q({ type: 'judge' }))).toBe(true);
  });
  it('fill / essay 不是选项题', () => {
    expect(isChoiceQuestion(q({ type: 'fill' }))).toBe(false);
    expect(isChoiceQuestion(q({ type: 'essay' }))).toBe(false);
  });
});

describe('选项题判分（single / multiple / judge 走同一条）', () => {
  it('单选勾中 ⇒ true，勾偏 ⇒ false', () => {
    const one = q({ type: 'single', options: ['a', 'b', 'c'], answer: [1] });
    expect(judgeQuizAnswer(one, { picked: [1] })).toBe(true);
    expect(judgeQuizAnswer(one, { picked: [0] })).toBe(false);
  });

  it('judge：答案下标是 0 或 1，与 single 完全同路（选项恒「正确/错误」两项）', () => {
    const t = q({ type: 'judge', options: ['正确', '错误'], answer: [0] });
    expect(judgeQuizAnswer(t, { picked: [0] })).toBe(true);
    expect(judgeQuizAnswer(t, { picked: [1] })).toBe(false);
  });

  it('多选：乱序算同一个答案', () => {
    const m = q({ type: 'multiple', options: ['a', 'b', 'c', 'd'], answer: [0, 2] });
    expect(judgeQuizAnswer(m, { picked: [0, 2] })).toBe(true);
    expect(judgeQuizAnswer(m, { picked: [2, 0] })).toBe(true);
  });

  it('多选：少勾与多勾都是错，不给部分分', () => {
    const m = q({ type: 'multiple', options: ['a', 'b', 'c', 'd'], answer: [0, 2] });
    expect(judgeQuizAnswer(m, { picked: [0] })).toBe(false);
    expect(judgeQuizAnswer(m, { picked: [0, 1, 2] })).toBe(false);
  });

  it('勾了重复下标 ⇒ 不判（畸形输入不折成"答错"，那是往流水里灌假负样本）', () => {
    const m = q({ type: 'multiple', options: ['a', 'b', 'c'], answer: [0, 1] });
    expect(judgeQuizAnswer(m, { picked: [0, 0] })).toBe(null);
  });

  it('一个没勾 ⇒ 不判（提交闸门本不该放行，真到了这里也不许记成"答错"）', () => {
    const one = q({ type: 'single', options: ['a', 'b'], answer: [0] });
    expect(judgeQuizAnswer(one, { picked: [] })).toBe(null);
    expect(judgeQuizAnswer(one, {})).toBe(null);
  });
});

describe('填空判分 —— 容错口径逐字照抄被删的旧前端实现', () => {
  const fill = q({ type: 'fill', answer: ['retrospect'] });

  it('前缀命中即算对（旧口径：取期望答案前 max(4, len-2) 个字符做子串命中）', () => {
    // 'retrospect' 长 10 ⇒ 取前 8 个字符 'retrospe'；'I have retrospect here' 含它
    expect(judgeQuizAnswer(fill, { text: 'I have retrospect here' })).toBe(true);
    // 只写到第 8 个字符之前 ⇒ 不命中，判错（这条是"口径偏松但不无限松"的边界）
    expect(judgeQuizAnswer(fill, { text: 'retros' })).toBe(false);
  });

  it('短答案（≤4 字符）按整串比：`max(4, len-2)` 的下限就是 4', () => {
    const short = q({ type: 'fill', answer: ['水'] });
    expect(judgeQuizAnswer(short, { text: '水圈' })).toBe(true);
    expect(judgeQuizAnswer(short, { text: '火' })).toBe(false);
  });

  it('answer 给成单串（模型两种都写）也判', () => {
    expect(judgeQuizAnswer(q({ type: 'fill', answer: '北京' }), { text: '北京市' })).toBe(true);
  });

  it('多空位：任一空位命中即算对（旧口径是 `.some`，不改成 `.every`）', () => {
    const two = q({ type: 'fill', answer: ['光合作用', '叶绿体'] });
    expect(judgeQuizAnswer(two, { text: '只答了叶绿体' })).toBe(true);
  });

  it('空白输入 ⇒ 不判', () => {
    expect(judgeQuizAnswer(fill, { text: '   ' })).toBe(null);
    expect(judgeQuizAnswer(fill, {})).toBe(null);
  });
});

describe('不判（返回 null）的三种成因，一种都不许塌成 false', () => {
  it('① essay 免检——沿用 `collect.ts` 的既有口径「不判分只给参考」', () => {
    const essay = q({ type: 'essay', answer: '参考要点', solution: '完整解答' });
    expect(judgeQuizAnswer(essay, { text: '我写了一整段' })).toBe(null);
    expect(judgeQuizAnswer(essay, { picked: [0] })).toBe(null);
  });

  it('② 题面缺答案钥匙 —— 没有钥匙就没有对错可说', () => {
    expect(judgeQuizAnswer(q({ type: 'single', options: ['a', 'b'] }), { picked: [0] })).toBe(null);
    expect(judgeQuizAnswer(q({ type: 'single', options: ['a', 'b'], answer: [] }), { picked: [0] })).toBe(null);
    expect(judgeQuizAnswer(q({ type: 'fill' }), { text: 'whatever' })).toBe(null);
  });

  it('③ 答案钥匙本身是坏的（下标非整数 / 负数）⇒ 不判，不猜', () => {
    expect(judgeQuizAnswer(q({ type: 'single', options: ['a', 'b'], answer: [-1] }), { picked: [0] })).toBe(null);
    expect(judgeQuizAnswer(q({ type: 'single', options: ['a', 'b'], answer: ['x'] as unknown as number[] }), { picked: [0] })).toBe(null);
  });

  it('未知/缺失的题型字符串（老数据或脏数据）⇒ 不判', () => {
    expect(judgeQuizAnswer({ question: '题干' } as unknown as QuizQuestion, { picked: [0] })).toBe(null);
  });
});

describe('跨包契约：五个题型各有明确归属（判 / 不判），没有第四种', () => {
  /**
   * ★ 这条防的是"加了第六种题型忘了改判分"：新类型会走进函数最后那条 `return null`，
   *   于是一张答得了的卡**永远不记账且不报错**——这类错只有"按题型清单过一遍"能提前抓到。
   *   每个题型的"标准正确作答"写在这里，与 `QUIZ_TYPES`（`content-blocks.ts:72`）逐一对齐。
   */
  const BY_TYPE: Array<{ type: QuizQuestion['type']; q: QuizQuestion; input: { picked?: number[]; text?: string }; judged: boolean }> =
    [
      { type: 'single', q: q({ type: 'single', options: ['a', 'b'], answer: [1] }), input: { picked: [1] }, judged: true },
      { type: 'multiple', q: q({ type: 'multiple', options: ['a', 'b', 'c'], answer: [0, 2] }), input: { picked: [2, 0] }, judged: true },
      { type: 'fill', q: q({ type: 'fill', answer: ['叶绿体'] }), input: { text: '叶绿体' }, judged: true },
      { type: 'judge', q: q({ type: 'judge', options: ['正确', '错误'], answer: [0] }), input: { picked: [0] }, judged: true },
      { type: 'essay', q: q({ type: 'essay', answer: '参考要点' }), input: { text: '整段解答' }, judged: false },
    ];

  it('判分表覆盖的题型 = `QUIZ_TYPES` 的全部（新增题型不改这张表就会红在这里）', () => {
    expect([...BY_TYPE.map((x) => x.type)].sort()).toEqual([...QUIZ_TYPES].sort());
  });

  it('逐题型过：判分的返回 true，免检的返回 null，不存在第三种返回值', () => {
    for (const x of BY_TYPE) {
      const r = judgeQuizAnswer(x.q, x.input);
      if (x.judged) expect(r, x.type).toBe(true);
      else expect(r, x.type).toBe(null);
    }
  });
});
