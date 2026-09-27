import { useState } from 'react';
import type { QuizQuestion, QuizReviewItem } from '@sb/shared';
import { QuizQuestionItem } from './QuizQuestionItem';
import { QuizReview } from './QuizReview';
import './quiz.css';
import './quiz-effects.css';

export function QuizCard({ title, questions, sessionId }: {
  title: string; questions: QuizQuestion[]; sessionId?: string | null;
}) {
  const [round, setRound] = useState(0);
  const [answers, setAnswers] = useState<Record<number, QuizReviewItem>>({});
  return <div className="quiz-card quiz-adventure">
    <div className="quiz-head"><span className="quiz-eyebrow">知识试炼</span>{title}</div>
    <p className="quiz-muted">先作答，再看懂。完成本组后可生成专属图文讲解。</p>
    {questions.map((q, i) => <QuizQuestionItem key={`${round}-${i}`} q={q} index={i}
      onComplete={(item) => setAnswers((prev) => ({ ...prev, [i]: item }))} />)}
    <QuizReview key={round} sessionId={sessionId} title={title} kind="quiz" total={questions.length}
      items={questions.flatMap((_, i) => answers[i] ? [answers[i]] : [])}
      onRetry={() => { setAnswers({}); setRound((n) => n + 1); }} />
  </div>;
}
