import { describe, it, expect } from 'vitest';
import type { QuizMix, QuizPayload, QuizQuestion } from '@sb/shared';
import { DEFAULT_QUIZ_MIX, MAX_QUIZ_PER_TYPE, MAX_QUIZ_TOTAL, normalizeQuizMix, mixTotal } from '@sb/shared';
import { parseQuizBlock, normalizeQuiz, buildMixInstruction, applyQuizMix } from './quiz.js';

const MIX: QuizMix = { single: 2, multiple: 0, fill: 1, essay: 1 };

/** 造题：选择题给足选项（否则 normalize 会丢），填空给数组答案 */
const q = (type: QuizQuestion['type'], i: number): QuizQuestion =>
  type === 'single' || type === 'multiple'
    ? { type, question: `Q${i}`, options: ['a', 'b'], answer: [0] }
    : { type, question: `Q${i}`, answer: type === 'fill' ? ['x'] : '要点' };

const payload = (...types: Array<QuizQuestion['type']>): QuizPayload => ({
  title: 'T',
  questions: types.map((t, i) => q(t, i)),
});

describe('learning/quiz — [QUIZ] 协议解析（AI 输出容错）', () => {
  it('标准 [QUIZ]...[/QUIZ] 包裹解析成功', () => {
    const out = parseQuizBlock(`好的，这是题目：\n[QUIZ]{"title":"T","questions":[{"type":"single","question":"Q?","options":["a","b"],"answer":[1],"explanation":"e"}]}[/QUIZ]`);
    expect(out?.title).toBe('T');
    expect(out?.questions).toHaveLength(1);
  });

  it('围栏/杂质容错（```json 与前后文本）', () => {
    const out = parseQuizBlock('前置说明\n```json\n{"questions":[{"type":"fill","question":"1+1=____","answer":["2"]}]}\n```\n后置');
    expect(out?.questions[0]?.type).toBe('fill');
  });

  it('非法 JSON → null（走降级，不崩 ADR-4）', () => {
    expect(parseQuizBlock('[QUIZ]not-json[/QUIZ]')).toBeNull();
    expect(parseQuizBlock('完全无关文本')).toBeNull();
  });

  it('normalize 丢弃无选项选择题 / 无题干题', () => {
    const out = normalizeQuiz({
      questions: [
        { type: 'single', question: '缺选项', options: ['x'] }, // 选项不足 2 → 丢
        { type: 'single', question: '', options: ['a', 'b'] }, // 无题干 → 丢
        { type: 'essay', question: '正常解答题' },
      ],
    });
    expect(out?.questions).toHaveLength(1);
    expect(out?.questions[0]?.type).toBe('essay');
  });
});

describe('learning/quiz — 题型配比归一化（契约由 shared 收口）', () => {
  it('负数/小数/非数字 → 钳到 0 或取整，单题型不超上限', () => {
    const out = normalizeQuizMix({ single: -3, multiple: 2.9, fill: 'x', essay: 99 });
    expect(out).toEqual({ single: 0, multiple: 2, fill: 0, essay: MAX_QUIZ_PER_TYPE });
  });

  it('总题数超上限时从后往前削，先保单选与多选', () => {
    const out = normalizeQuizMix({ single: 10, multiple: 10, fill: 10, essay: 10 });
    expect(mixTotal(out)).toBe(MAX_QUIZ_TOTAL);
    expect(out.single).toBe(MAX_QUIZ_PER_TYPE);
    expect(out.multiple).toBe(MAX_QUIZ_PER_TYPE);
    expect(out.fill).toBe(0);
    expect(out.essay).toBe(0);
  });

  it('四档全 0 回退默认配比（0 题的题组没意义，不静默出空气）', () => {
    expect(normalizeQuizMix({ single: 0, multiple: 0, fill: 0, essay: 0 })).toEqual(DEFAULT_QUIZ_MIX);
    expect(normalizeQuizMix(undefined)).toEqual(DEFAULT_QUIZ_MIX);
  });
});

describe('learning/quiz — 配比指令与裁剪（模型不数数时的兜底）', () => {
  it('指令写明总题数、各题型几道，并点名 0 档不要出', () => {
    const text = buildMixInstruction(MIX);
    expect(text).toContain('总共恰好 4 道题');
    expect(text).toContain('单选题 2 道');
    expect(text).toContain('填空题 1 道');
    expect(text).toContain('解答题 1 道');
    expect(text).toContain('不要出多选题');
  });

  it('出齐了：matched true 且一题不多一题不少', () => {
    const { quiz, report } = applyQuizMix(payload('single', 'single', 'fill', 'essay'), MIX);
    expect(quiz?.questions).toHaveLength(4);
    expect(report.matched).toBe(true);
    expect(report.actual).toEqual(MIX);
  });

  it('多出的裁掉：模型给了 3 道单选也只留 2 道，且保留原题顺序', () => {
    const { quiz, report } = applyQuizMix(payload('single', 'single', 'single', 'fill', 'essay'), MIX);
    expect(quiz?.questions).toHaveLength(4);
    expect(report.actual.single).toBe(2);
    expect(quiz?.questions[2]?.type).toBe('fill');
  });

  it('少出的如实报：matched false 且不补题（ADR-5 三态反馈）', () => {
    const { quiz, report } = applyQuizMix(payload('single', 'single', 'fill'), MIX);
    expect(quiz?.questions).toHaveLength(3);
    expect(report.matched).toBe(false);
    expect(report.actual.essay).toBe(0);
    expect(report.requested.essay).toBe(1);
  });

  it('模型自造题型不在四档内 → 丢弃（宁缺勿乱）', () => {
    const { quiz, report } = applyQuizMix(payload('judge' as QuizQuestion['type'], 'single'), MIX);
    expect(quiz?.questions.map((x) => x.type)).toEqual(['single']);
    expect(report.matched).toBe(false);
  });

  it('裁完 0 题返回 null（调用方走 502，不发空题组）', () => {
    const { quiz, report } = applyQuizMix(payload('judge' as QuizQuestion['type']), MIX);
    expect(quiz).toBeNull();
    expect(report.actual).toEqual({ single: 0, multiple: 0, fill: 0, essay: 0 });
  });
});
