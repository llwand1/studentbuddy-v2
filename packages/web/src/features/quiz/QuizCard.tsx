import { useRef, useState } from 'react';
import type { QuizQuestion, QuizReviewItem } from '@sb/shared';
import { countTiers, quizAttemptLine, tierSummaryLine } from '@sb/shared';
import { QuizQuestionItem } from './QuizQuestionItem';
import { QuizReview } from './QuizReview';
import { useQuizAttempts } from './useQuizAttempts';
import { formatMsgTime } from '../chat/chat-meta';
import './quiz.css';
import './quiz-effects.css';
import { AnswerSoundToggle } from '../feedback/AnswerImpact';

/**
 * 题卡。`quizId`（2026-09-23 之后出的题都带）是作答记录的键：每答一题记一笔到服务端，重开会话时
 * 顶部一行「刷过 N 遍 · 客观题正确率」、每题一枚「上次 ✓／↗／◇」（契约 QUIZ-REVIEW-SPEC「作答记录」节）。
 * 本轮的作答与图文讲解仍只活在当前页面——记录的是**结果**，不是把整张卡冻结。
 */
export function QuizCard({ title, questions, sessionId, quizId }: {
  title: string; questions: QuizQuestion[]; sessionId?: string | null; quizId?: string;
}) {
  const [round, setRound] = useState(0);
  const [answers, setAnswers] = useState<Record<number, QuizReviewItem>>({});
  const [chain, setChain] = useState(0);
  const completed = useRef(new Set<number>());
  const tiers = tierSummaryLine(countTiers(questions));
  const attempts = useQuizAttempts(quizId, questions);
  const line = quizAttemptLine(attempts.summary);
  const lastAt = attempts.summary.lastAt ? formatMsgTime(attempts.summary.lastAt) : '';
  return <div className="quiz-card quiz-adventure">
    <div className="quiz-head"><AnswerSoundToggle /><span className="quiz-eyebrow">知识试炼</span>{title}</div>
    {chain > 1 && <p key={chain} className="quiz-momentum" role="status">连续命中 {chain} 题</p>}
    <p className="quiz-muted">先作答，再看懂。完成本组后可生成专属图文讲解。{tiers ? ` 本组：${tiers}。` : ''}</p>
    {line && <p className="quiz-attempt-line" role="status">
      <span className="quiz-attempt-tag">记录</span>{line}{lastAt ? ` · 最近 ${lastAt}` : ''}
    </p>}
    {attempts.error && <p className="quiz-attempt-error" role="alert">{attempts.error}</p>}
    {questions.map((q, i) => <QuizQuestionItem key={`${round}-${i}`} q={q} index={i} topic={title} last={attempts.lastOf(i)}
      onComplete={(item) => {
        if (completed.current.has(i)) return;
        completed.current.add(i); setChain(n => item.verdict === 'correct' ? n + 1 : 0);
        setAnswers((prev) => ({ ...prev, [i]: item })); attempts.record(i, item);
      }} />)}
    <QuizReview key={round} sessionId={sessionId} title={title} kind="quiz" total={questions.length} recorded={attempts.enabled}
      items={questions.flatMap((_, i) => answers[i] ? [answers[i]] : [])}
      onRetry={() => { completed.current.clear(); setChain(0); setAnswers({}); setRound((n) => n + 1); }} />
  </div>;
}
