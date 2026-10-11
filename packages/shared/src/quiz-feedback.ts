import type { QuizPayload, QuizQuestion } from './content-blocks.js';
import type { QuizReviewItem } from './quiz-explanation.js';

export const QUIZ_FEEDBACK_MAX = 600;
export interface QuizFeedbackOption { id: string; label: string; description: string }
export interface QuizFeedbackRequest {
  question: QuizQuestion;
  title: string;
  sessionId?: string;
  attempt?: Pick<QuizReviewItem, 'answer' | 'verdict'>;
  feedback?: string;
}
export interface QuizFeedbackChoices { options: QuizFeedbackOption[] }
export interface QuizFeedbackResult { quizId: string; quiz: QuizPayload; announced: boolean }
