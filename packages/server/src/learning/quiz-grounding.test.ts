import { describe, expect, it } from 'vitest';
import { emptyQuizImageReport, emptyQuizSearchReport } from '@sb/shared';
import type { QuizPayload } from '@sb/shared';
import { groundQuiz } from './quiz-grounding.js';
const url = 'https://study.example/java';
const quiz: QuizPayload = { title: 'Java 线程池', questions: [{ type: 'essay', question: '线程池有哪些拒绝策略？', source: { kind: 'web', title: 'Java', url } }] };
function report() {
  const search = emptyQuizSearchReport(true);
  search.refs = [{ n: 1, title: 'Java', url, provider: 'entry' }];
  search.scope = { on: true, summary: '技术', kept: 1, dropped: 0, directSites: [], empty: false, hostsEmpty: false };
  return search;
}
describe('应试实时出题的依据校验', () => {
  it('引用本次真实来源的题保留，无引用或伪造来源的题剔除并说明', () => {
    const search = report();
    const extra = [{ type: 'essay' as const, question: '无引用题' }, { ...quiz.questions[0]!, source: { kind: 'web' as const, title: '伪造', url: 'https://evil.example/' } }];
    const out = groundQuiz({ ...quiz, questions: [...quiz.questions, ...extra] }, search, 'Java 线程池');
    expect(out?.questions).toEqual(quiz.questions);
    expect(search.failed[0]).toContain('2 道题');
  });
  it('全数没有依据时返回明确的 grounding 失败，不当作解析失败', () => {
    const images = emptyQuizImageReport();
    expect(groundQuiz({ title: 'T', questions: [{ type: 'essay', question: '无引用题' }] }, report(), 'Java', images)).toBeNull();
    expect(images.failure).toBe('ungrounded');
  });
  it('引用真实 Java 来源也不能混入 C++ 题，跨语言比较主题仍允许', () => {
    const mixed = { ...quiz, questions: [{ ...quiz.questions[0]!, question: 'C++ 智能指针如何管理内存？' }] };
    expect(groundQuiz(mixed, report(), 'Java')).toBeNull();
    expect(groundQuiz(mixed, report(), 'Java 与 C++ 比较')?.questions).toHaveLength(1);
  });
  it('没开应试模式或没有参考时保留原来的基础巩固行为', () => {
    expect(groundQuiz(quiz, undefined, 'Java')).toBe(quiz);
    const search = report(); search.refs = [];
    expect(groundQuiz(quiz, search, 'Java')).toBe(quiz);
  });
});
