import { describe, it, expect } from 'vitest';
import type { QuizQuestion } from '@sb/shared';
import { formatCorrectAnswer, formatMyAnswer } from './note-format';

const single: QuizQuestion = { type: 'single', question: 'q', options: ['a', 'b', 'c'], answer: [1] };
const multi: QuizQuestion = { type: 'multiple', question: 'q', options: ['a', 'b', 'c'], answer: [0, 2] };
const fill: QuizQuestion = { type: 'fill', question: 'q', answer: ['x', 'y'] };
const essay: QuizQuestion = { type: 'essay', question: 'q', answer: '要点', solution: '完整解答' };

describe('formatCorrectAnswer', () => {
  it('单选/多选转字母，多选顿号相连', () => {
    expect(formatCorrectAnswer(single)).toBe('B');
    expect(formatCorrectAnswer(multi)).toBe('A、C');
  });

  it('填空按空位分号相连', () => {
    expect(formatCorrectAnswer(fill)).toBe('x；y');
  });

  it('解答给参考要点，缺要点回退完整解答，再缺给占位', () => {
    expect(formatCorrectAnswer(essay)).toBe('要点');
    expect(formatCorrectAnswer({ ...essay, answer: '' })).toBe('完整解答');
    expect(formatCorrectAnswer({ ...essay, answer: '', solution: undefined })).toBe('—');
  });
});

describe('formatMyAnswer', () => {
  it('下标数组转字母；文本原样；null 如实说未记录', () => {
    expect(formatMyAnswer(single, [0, 2])).toBe('A、C');
    expect(formatMyAnswer(fill, '我写的内容')).toBe('我写的内容');
    expect(formatMyAnswer(essay, null)).toBe('（未记录作答）');
  });

  it('空数组/空白文本给占位而不是空白', () => {
    expect(formatMyAnswer(single, [])).toBe('—');
    expect(formatMyAnswer(fill, '  ')).toBe('—');
  });
});
