/**
 * quiz-verify 单测 — 锁三条保守纪律(issue #71):
 * ① 只有「明确不一致」才丢题;② solver 一切失败形态都放行记 unresolved;
 * ③ 无客观口径的题型不碰。外加解析器与集合比较的边界。
 */
import { describe, expect, it } from 'vitest';
import type { QuizPayload, QuizQuestion } from '@sb/shared';
import {
  buildSolvePrompt,
  emptyVerifyReport,
  parseAnswerSet,
  sameAnswerSet,
  verifyQuiz,
} from './quiz-verify.js';

const single = (over: Partial<QuizQuestion> = {}): QuizQuestion =>
  ({
    type: 'single',
    question: '1+1=?',
    options: ['1', '2', '3', '4'],
    answer: [1],
    explanation: 'x',
    ...over,
  }) as QuizQuestion;

const quizOf = (...questions: QuizQuestion[]): QuizPayload => ({ title: 'T', questions });

describe('parseAnswerSet', () => {
  it('单选:首个合法字母;大小写/杂质容忍', () => {
    expect(parseAnswerSet('答案是 b。', 4, false)).toEqual([1]);
    expect(parseAnswerSet('B', 4, false)).toEqual([1]);
  });
  it('单选答出两个不同字母=矛盾 → null(不猜)', () => {
    expect(parseAnswerSet('B 或 C', 4, false)).toBeNull();
  });
  it('多选:收集全部合法字母并排序去重', () => {
    expect(parseAnswerSet('AC', 4, true)).toEqual([0, 2]);
    expect(parseAnswerSet('C、A、C', 4, true)).toEqual([0, 2]);
  });
  it('越界字母不算:两选项题里的 D 不是答案', () => {
    expect(parseAnswerSet('D', 2, false)).toBeNull();
  });
  it('无任何合法字母 → null', () => {
    expect(parseAnswerSet('无法判断', 4, false)).toBeNull();
  });
});

describe('sameAnswerSet', () => {
  it('顺序无关、长度必须相等', () => {
    expect(sameAnswerSet([0, 2], [2, 0])).toBe(true);
    expect(sameAnswerSet([0], [0, 2])).toBe(false);
    expect(sameAnswerSet([1], [2])).toBe(false);
  });
});

describe('buildSolvePrompt(无泄漏)', () => {
  it('只含题干+选项;答案与解析绝不入内', () => {
    const p = buildSolvePrompt(single({ explanation: '秘密解析', answer: [1] }));
    expect(p).toContain('1+1=?');
    expect(p).toContain('B. 2');
    expect(p).not.toContain('秘密解析');
    expect(p).not.toContain('answer');
  });
});

describe('verifyQuiz', () => {
  it('一致 → 放行,passed+1', async () => {
    const report = emptyVerifyReport();
    const out = await verifyQuiz(quizOf(single()), async () => 'B', report);
    expect(out?.questions).toHaveLength(1);
    expect(report).toMatchObject({ checked: 1, passed: 1, dropped: 0, unresolved: 0 });
  });
  it('明确不一致 → 丢弃,dropped+1(纪律①)', async () => {
    const report = emptyVerifyReport();
    const out = await verifyQuiz(quizOf(single(), single({ question: '2+2=?', answer: [3] })), async (q) => (q.question === '1+1=?' ? 'B' : 'A'), report);
    expect(out?.questions.map((q) => q.question)).toEqual(['1+1=?']);
    expect(report).toMatchObject({ passed: 1, dropped: 1 });
  });
  it('solver 返回 null → 放行记 unresolved(纪律②)', async () => {
    const report = emptyVerifyReport();
    const out = await verifyQuiz(quizOf(single()), async () => null, report);
    expect(out?.questions).toHaveLength(1);
    expect(report).toMatchObject({ unresolved: 1, dropped: 0 });
  });
  it('solver 抛异常 → 放行记 unresolved,不打断整组(纪律②)', async () => {
    const report = emptyVerifyReport();
    const out = await verifyQuiz(quizOf(single(), single({ question: '2+2=?' })), async (q) => {
      if (q.question === '1+1=?') throw new Error('boom');
      return 'B';
    }, report);
    expect(out?.questions).toHaveLength(2);
    expect(report).toMatchObject({ unresolved: 1, passed: 1 });
  });
  it('解析不出(矛盾回答)→ 放行记 unresolved(纪律②反向锁:绝不当 dropped)', async () => {
    const report = emptyVerifyReport();
    const out = await verifyQuiz(quizOf(single()), async () => 'B 或者 C 吧', report);
    expect(out?.questions).toHaveLength(1);
    expect(report).toMatchObject({ unresolved: 1, dropped: 0 });
  });
  it('fill/essay 不验,原样放行记 skipped(纪律③);solver 一次都不该被调', async () => {
    const report = emptyVerifyReport();
    let calls = 0;
    const fill = { type: 'fill', question: 'x 是____', answer: ['2'], explanation: 'x' } as unknown as QuizQuestion;
    const essay = { type: 'essay', question: '谈谈 x', answer: '要点', explanation: '' } as unknown as QuizQuestion;
    const out = await verifyQuiz(quizOf(fill, essay), async () => { calls += 1; return 'A'; }, report);
    expect(out?.questions).toHaveLength(2);
    expect(calls).toBe(0);
    expect(report).toMatchObject({ skipped: 2, checked: 0 });
  });
  it('judge 题按单选口径验(两选项)', async () => {
    const judge = single({ type: 'judge', options: ['正确', '错误'], answer: [0] });
    const ok = await verifyQuiz(quizOf(judge), async () => 'A');
    expect(ok?.questions).toHaveLength(1);
    const bad = await verifyQuiz(quizOf(judge), async () => 'B');
    expect(bad).toBeNull();
  });
  it('multiple 按集合比较:少选/多选都算不一致', async () => {
    const multi = single({ type: 'multiple', answer: [0, 2] });
    expect((await verifyQuiz(quizOf(multi), async () => 'CA'))?.questions).toHaveLength(1);
    expect(await verifyQuiz(quizOf(multi), async () => 'A')).toBeNull();
    expect(await verifyQuiz(quizOf(multi), async () => 'ACD')).toBeNull();
  });
  it('全部被拦 → 返回 null(走 502 降级,不返回空题组——与 applyQuizMix 同口径)', async () => {
    expect(await verifyQuiz(quizOf(single()), async () => 'C')).toBeNull();
  });
});
