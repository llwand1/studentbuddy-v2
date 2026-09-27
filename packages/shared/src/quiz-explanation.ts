/** 对话内练习的图文复盘；不恢复题库或逐题统计。 */
export interface QuizReviewItem {
  question: string;
  answer: string;
  expected: string;
  verdict: 'correct' | 'wrong' | 'review';
  context: string;
}
export interface QuizExplanationRequest {
  sessionId: string;
  title: string;
  kind: 'quiz' | 'scenario';
  items: QuizReviewItem[];
}
export interface QuizExplanationSection {
  title: string;
  /** 从 1 开始，对应本次提交的题目/任务。 */
  questions: number[];
  explanation: string;
  svg: string;
  caption: string;
}
export interface QuizExplanation {
  summary: string;
  sections: QuizExplanationSection[];
  transfer: { question: string; answer: string };
}
