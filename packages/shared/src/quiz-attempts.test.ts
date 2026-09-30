/**
 * quiz-attempts.test — 作答记录的两端共用口径：一行怎么随一次作答变、整组怎么概括、那一行字怎么念。
 */
import { describe, it, expect } from 'vitest';
import { applyQuizAttempt, quizAttemptLine, summarizeQuizAttempts, type QuizAttemptRow } from './quiz-attempts.js';

const at = '2026-09-30T06:00:00.000Z';

describe('applyQuizAttempt', () => {
  it('新行：答对 ⇒ attempts/correct/streak/best 全 1，last 带判定、作答与时间', () => {
    const row = applyQuizAttempt(undefined, { questionIndex: 2, verdict: 'correct', answer: 'A. 速度方向' }, at);
    expect(row).toEqual({ index: 2, attempts: 1, correct: 1, streak: 1, bestStreak: 1, last: { verdict: 'correct', answer: 'A. 速度方向', at } });
  });

  it('答错 streak 归零、best 留着；待对照只计次数、streak 与 correct 都不动；作答文字截到上限', () => {
    let row = applyQuizAttempt(undefined, { questionIndex: 0, verdict: 'correct', answer: 'x' }, at);
    row = applyQuizAttempt(row, { questionIndex: 0, verdict: 'correct', answer: 'x' }, at);
    expect([row.streak, row.bestStreak]).toEqual([2, 2]);
    row = applyQuizAttempt(row, { questionIndex: 0, verdict: 'wrong', answer: 'y' }, at);
    expect([row.attempts, row.correct, row.streak, row.bestStreak, row.last?.verdict]).toEqual([3, 2, 0, 2, 'wrong']);
    row = applyQuizAttempt(row, { questionIndex: 0, verdict: 'correct', answer: 'x' }, at);
    row = applyQuizAttempt(row, { questionIndex: 0, verdict: 'review', answer: 'z'.repeat(900) }, '2026-09-30T07:00:00.000Z');
    expect([row.attempts, row.correct, row.streak, row.last?.verdict]).toEqual([5, 3, 1, 'review']);
    expect(row.last?.answer).toHaveLength(500);
    expect(row.last?.at).toBe('2026-09-30T07:00:00.000Z');
  });
});

describe('summarizeQuizAttempts / quizAttemptLine', () => {
  const rows: QuizAttemptRow[] = [
    { index: 0, attempts: 2, correct: 2, streak: 2, bestStreak: 2, last: { verdict: 'correct', answer: 'A', at: '2026-09-30T05:00:00.000Z' } },
    { index: 1, attempts: 2, correct: 1, streak: 0, bestStreak: 1, last: { verdict: 'wrong', answer: 'B', at: '2026-09-30T06:00:00.000Z' } },
    { index: 2, attempts: 1, correct: 0, streak: 0, bestStreak: 0, last: { verdict: 'review', answer: '略', at: '2026-09-30T04:00:00.000Z' } },
  ];

  it('刷过几遍 = attempts 最大值；解答题不进正确率；lastAt 取最晚', () => {
    const s = summarizeQuizAttempts(rows, ['single', 'fill', 'essay']);
    expect(s).toEqual({ rounds: 2, objectiveAttempts: 4, objectiveCorrect: 3, accuracy: 0.75, lastAt: '2026-09-30T06:00:00.000Z' });
    expect(quizAttemptLine(s)).toBe('刷过 2 遍 · 客观题正确率 75%（3/4）');
  });

  it('只答过解答题 ⇒ 正确率 null、那行字不写百分比；一行没有 ⇒ 空串', () => {
    const s = summarizeQuizAttempts([rows[2] as QuizAttemptRow], ['single', 'fill', 'essay']);
    expect(s.accuracy).toBeNull();
    expect(quizAttemptLine(s)).toBe('刷过 1 遍');
    expect(quizAttemptLine(summarizeQuizAttempts([], []))).toBe('');
  });

  it('★ 越界的题号（题组后来变短）不计入正确率，但仍算遍数——记录不撒谎', () => {
    const s = summarizeQuizAttempts([{ ...rows[0] as QuizAttemptRow, index: 9 }], ['single']);
    expect(s).toMatchObject({ rounds: 2, objectiveAttempts: 0, accuracy: null });
  });
});
