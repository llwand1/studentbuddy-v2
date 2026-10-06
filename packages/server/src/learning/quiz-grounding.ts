/** 本次联网资料与交付题目之间的硬门：不把无引用题当成实时资料出题。 */
import type { QuizImageReport, QuizPayload, QuizSearchReport } from '@sb/shared';
import { conflictingLanguage } from '../search/exam-query.js';

export function groundQuiz(
  quiz: QuizPayload | null, search: QuizSearchReport | undefined, topic: string, report?: QuizImageReport,
): QuizPayload | null {
  if (!quiz || !search?.scope?.on || search.refs.length === 0) return quiz;
  const allowed = new Set(search.refs.map((r) => r.url));
  const questions = quiz.questions.filter((q) => q.source?.kind === 'web' && !!q.source.url && allowed.has(q.source.url)
    && !conflictingLanguage(`${q.question} ${q.material ?? ''}`, topic));
  const dropped = quiz.questions.length - questions.length;
  if (dropped > 0) search.failed.push(`${dropped} 道题未引用本次资料或与本次主题语言不符，已剔除`);
  if (questions.length === 0) {
    if (report) report.failure = 'ungrounded';
    return null;
  }
  return { ...quiz, questions };
}
