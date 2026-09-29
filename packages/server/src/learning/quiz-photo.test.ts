/** learning/quiz-photo —— 配图规划解析与答案抽取（2026-09-29）。 */
import { describe, it, expect } from 'vitest';
import { parsePhotoPlan, answerTexts, MAX_PHOTOS } from './quiz-photo.js';

describe('parsePhotoPlan', () => {
  it('越界/重复/空检索词丢弃，最多 MAX_PHOTOS 条', () => {
    const raw = JSON.stringify({ photos: [
      { index: 0, query: 'Great Wall', subject: '长城' }, { index: 0, query: 'dup' }, { index: 9, query: 'oob' },
      { index: 1, query: '' }, { index: 2, query: 'Terracotta Army' }, { index: 3, query: 'more' },
    ] });
    const p = parsePhotoPlan(raw, 4)!;
    expect(p.map((x) => x.index)).toEqual([0, 2]);
    expect(p).toHaveLength(MAX_PHOTOS);
    expect(p[1]!.subject).toBe('Terracotta Army');
  });
  it('空数组合法；非 JSON → null', () => {
    expect(parsePhotoPlan('{"photos":[]}', 3)).toEqual([]);
    expect(parsePhotoPlan('不配图', 3)).toBeNull();
  });
});

describe('answerTexts', () => {
  it('选择题取正确选项文字；填空取答案；判断题不给（正确/错误无从泄露）', () => {
    expect(answerTexts({ type: 'single', question: 'q', options: ['甲', '乙'], answer: [1] } as never)).toEqual(['乙']);
    expect(answerTexts({ type: 'fill', question: 'q', answer: ['长城'] } as never)).toEqual(['长城']);
    expect(answerTexts({ type: 'judge', question: 'q', options: ['正确', '错误'], answer: [0] } as never)).toEqual([]);
  });
});
