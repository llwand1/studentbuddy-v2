import type { QuizQuestion, QuizReviewItem } from '@sb/shared';

export interface QuizAttempt { picked: number[]; fills: string[]; essay: string }
export const optionsFor = (q: QuizQuestion) => q.type === 'judge' ? ['正确', '错误'] : q.options ?? [];
export const fillCount = (q: QuizQuestion) => Math.max(1, Array.isArray(q.answer) ? q.answer.length : 1);
const normal = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ');

export function reviewAttempt(q: QuizQuestion, attempt: QuizAttempt): QuizReviewItem {
  const options = optionsFor(q);
  const choice = ['single', 'multiple', 'judge'].includes(q.type);
  const expected = Array.isArray(q.answer) ? q.answer : q.answer ? [q.answer] : [];
  const describe = (ns: number[]) => ns.map((n) => `${String.fromCharCode(65 + n)}. ${options[n] ?? ''}`).join('；');
  let verdict: QuizReviewItem['verdict'] = 'review';
  if (choice && expected.length && expected.every((v) => Number.isInteger(Number(v)) && options[Number(v)] !== undefined)) {
    const wanted = new Set(expected.map(Number));
    verdict = wanted.size === attempt.picked.length && attempt.picked.every((n) => wanted.has(n)) ? 'correct' : 'wrong';
  } else if (q.type === 'fill' && expected.length) {
    // 只做逐空文字对照：同义词/等价式交给讲解讨论，不宣称语义判分。
    verdict = expected.length === attempt.fills.length
      && expected.every((v, i) => normal(String(v)) === normal(attempt.fills[i] ?? '')) ? 'correct' : 'review';
  }
  return {
    question: q.question,
    answer: choice ? describe(attempt.picked) : q.type === 'fill' ? attempt.fills.join('；') : attempt.essay,
    expected: choice ? describe(expected.map(Number)) || '未提供参考答案' : expected.join('；') || q.solution || '未提供参考答案',
    verdict,
    context: [options.length ? `选项：${describe(options.map((_, i) => i))}` : '', q.explanation, q.solution,
      q.type === 'fill' ? '填空按逐空文字匹配核对；不匹配待复核，不表示语义错误。' : ''].filter(Boolean).join('\n'),
  };
}
