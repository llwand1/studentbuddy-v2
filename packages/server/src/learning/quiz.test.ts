import { describe, it, expect } from 'vitest';
import { parseQuizBlock, normalizeQuiz } from './quiz.js';

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
