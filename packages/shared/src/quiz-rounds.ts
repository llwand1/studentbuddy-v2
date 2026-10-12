import type { QuizQuestion } from './content-blocks.js';
import type { QuizReviewItem, QuizExplanation } from './quiz-explanation.js';
import type { GradeResult } from './learner.js';
import { judgeTask } from './scenario.js';

export interface QuizDraftAnswer { picked: number[]; fills: string[]; essay: string }
export type QuestionReviewStatus = 'none' | 'queued' | 'grading' | 'analyzing' | 'illustrating' | 'complete' | 'error' | 'cancelled';
export interface QuizRoundResponse {
  index: number;
  revision: number;
  draft: QuizDraftAnswer;
  thought: string;
  result: QuizReviewItem | null;
  grade: GradeResult | null;
  status: QuestionReviewStatus;
  generation: number;
  analysis: string;
  analysisReady: boolean;
  recorded: boolean;
  illustration: QuizExplanation | null;
  error: string;
}
export interface QuizRound {
  id: string;
  quizKey: string;
  quizId: string;
  title: string;
  origin: OpenQuizRound['origin'];
  sessionId: string | null;
  number: number;
  state: 'draft' | 'submitted';
  revision: number;
  questions: QuizQuestion[];
  responses: QuizRoundResponse[];
  previousId: string | null;
  latestId: string;
}
export interface OpenQuizRound {
  title: string;
  questions: QuizQuestion[];
  quizId?: string;
  sessionId?: string;
  origin: 'chat' | 'arrival' | 'desktop' | 'scenario';
}
export interface QuizRoundHistoryEntry { id: string; title: string; number: number; state: QuizRound['state']; origin: OpenQuizRound['origin']; createdAt: string; questionCount: number }
export interface QuizRoundHistory { items: QuizRoundHistoryEntry[]; nextCursor: string | null }
export type QuizRoundEvent = { type: 'round'; round: QuizRound }
  | { type: 'delta'; roundId: string; index: number; generation: number; revision: number; delta: string };
export const QUIZ_THOUGHT_MAX = 4000;
export const QUIZ_ROUND_MAX = 20;
export const QUIZ_REVIEW_ACTIVE: readonly QuestionReviewStatus[] = ['queued', 'grading', 'analyzing', 'illustrating'];
export const quizOptions = (q: QuizQuestion): string[] => q.type === 'judge' ? ['正确', '错误'] : q.options ?? [];
export const quizFillCount = (q: QuizQuestion): number => Math.max(1, Array.isArray(q.answer) ? q.answer.length : 1);
export function blankQuizAnswer(q: QuizQuestion): QuizDraftAnswer { return { picked: [], fills: Array<string>(quizFillCount(q)).fill(''), essay: '' }; }
export function quizAnswerReady(q: QuizQuestion, a: QuizDraftAnswer): boolean {
  return ['single', 'multiple', 'judge'].includes(q.type) ? a.picked.length > 0 : q.type === 'fill' ? a.fills.every(s => !!s.trim()) : !!a.essay.trim();
}
export function parseQuizDraft(v: unknown, q: QuizQuestion): QuizDraftAnswer | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (!Array.isArray(a.picked) || a.picked.length > quizOptions(q).length
    || a.picked.some(n => typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= quizOptions(q).length)
    || new Set(a.picked).size !== a.picked.length || (q.type !== 'multiple' && a.picked.length > 1)
    || !Array.isArray(a.fills) || a.fills.length !== quizFillCount(q)
    || a.fills.some(s => typeof s !== 'string' || s.length > 4000) || typeof a.essay !== 'string' || a.essay.length > 4000) return null;
  return { picked: a.picked as number[], fills: a.fills as string[], essay: a.essay };
}
const normal = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ');
/** Answer checking uses the submitted answer only; optional thinking cannot replace it. */
export function checkQuizAnswer(q: QuizQuestion, a: QuizDraftAnswer): QuizReviewItem {
  if (q.scenarioTask) return { question: q.question, answer: a.essay, expected: JSON.stringify(q.scenarioTask.criteria),
    verdict: judgeTask(q.scenarioTask.criteria, JSON.parse(a.essay)) ? 'correct' : 'wrong', context: q.explanation ?? '' };
  const options = quizOptions(q);
  const choice = ['single', 'multiple', 'judge'].includes(q.type);
  const expected = Array.isArray(q.answer) ? q.answer : q.answer ? [q.answer] : [];
  const describe = (ns: number[]) => ns.map(n => `${String.fromCharCode(65 + n)}. ${options[n] ?? ''}`).join('；');
  let verdict: QuizReviewItem['verdict'] = 'review';
  if (choice && expected.length && expected.every(v => Number.isInteger(Number(v)) && options[Number(v)] !== undefined)) {
    const wanted = new Set(expected.map(Number));
    verdict = wanted.size === a.picked.length && a.picked.every(n => wanted.has(n)) ? 'correct' : 'wrong';
  } else if (q.type === 'fill' && expected.length) {
    verdict = expected.length === a.fills.length && expected.every((v, i) => normal(String(v)) === normal(a.fills[i] ?? '')) ? 'correct' : 'review';
  }
  return { question: q.question, answer: choice ? describe(a.picked) : q.type === 'fill' ? a.fills.join('；') : a.essay,
    expected: choice ? describe(expected.map(Number)) || '未提供参考答案' : expected.join('；') || q.solution || '未提供参考答案', verdict,
    context: [q.material, options.length ? `选项：${describe(options.map((_, i) => i))}` : '', q.explanation, q.solution,
      q.type === 'fill' ? '填空文字不匹配待复核，不等同于语义错误。' : ''].filter(Boolean).join('\n') };
}
