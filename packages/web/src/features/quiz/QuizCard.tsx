import { useEffect, useRef, useState } from 'react';
import type { QuizFeedbackResult, QuizPayload, QuizQuestion, QuizRound, OpenQuizRound } from '@sb/shared';
import { quizAnswerReady, quizAttemptLine, countTiers, tierSummaryLine } from '@sb/shared';
import { QuizQuestionItem } from './QuizQuestionItem';
import { useQuizRound } from './useQuizRound';
import { useQuizAttempts } from './useQuizAttempts';
import { QuizRoundHistoryPanel } from './QuizRoundHistory';
import { useGuideCap } from '../guide/use-guide-cap';
import './quiz.css';
import './quiz-effects.css';
import './question-thinking.css';
import { AnswerImpact, AnswerSoundToggle } from '../feedback/AnswerImpact';
import { ScenarioPanel } from './ScenarioPanel';

/**
 * Four quiz entry points share autosaved rounds and independent streamed question analysis.
 */
export function QuizCard({ title, questions, sessionId, quizId, feedback, onAdapted, origin = 'chat', compact = false, recordId, onRoundChange, onSubmitted, disabled = false }: {
  title: string; questions: QuizQuestion[]; sessionId?: string | null; quizId?: string; feedback?: QuizPayload['feedback'];
  onAdapted?: (result: QuizFeedbackResult) => void; origin?: OpenQuizRound['origin']; compact?: boolean; recordId?: string;
  onRoundChange?: (round: QuizRound | null) => void; onSubmitted?: (round: QuizRound) => void;
  disabled?: boolean;
}) {
  const rounds = useQuizRound({ title, questions, origin, ...(quizId ? { quizId } : {}), ...(sessionId ? { sessionId } : {}) }, recordId);
  const [followups, setFollowups] = useState<QuizFeedbackResult[]>([]);
  const [history, setHistory] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const append = onAdapted ?? ((next: QuizFeedbackResult) => setFollowups(prev => [...prev, next]));
  const r = rounds.round;
  const attempts = useQuizAttempts(r?.quizId ?? quizId, r?.questions ?? questions,
    `${r?.id}:${r?.responses.filter(a => a.recorded).length ?? 0}`);
  const attemptLine = quizAttemptLine(attempts.summary), tiers = tierSummaryLine(countTiers(r?.questions ?? questions));
  useEffect(() => onRoundChange?.(r), [r, onRoundChange]);
  const answered = r?.questions.filter((q, i) => quizAnswerReady(q, r.responses[i]!.draft)).length ?? 0;
  const submitted = r?.state === 'submitted';
  const submit = async () => { const next = await rounds.submit(); if (next) onSubmitted?.(next); };
  useGuideCap('quiz.explain', r && !submitted && answered === r.questions.length && !rounds.acting ? () => {
    sectionRef.current?.scrollIntoView?.({ block: 'center' }); void submit();
  } : null);
  useGuideCap('quiz.retry', submitted && !rounds.busy && !rounds.acting ? () => void rounds.next() : null);
  if (r?.origin === 'scenario') return <ScenarioPanel quizId={r.quizId} recordId={r.id} sessionId={r.sessionId}
    demoId={r.questions[0]?.scenarioTask?.demoId ?? ''} payload={{ title: r.title, tasks: r.questions.flatMap(q => q.scenarioTask
      ? [{ id: q.scenarioTask.id, prompt: q.question, criteria: q.scenarioTask.criteria, hint: q.explanation }] : []) }} />;
  return <><div ref={sectionRef} className={`quiz-card quiz-adventure${compact ? ' is-compact' : ''}`}>
    <div className="quiz-head"><AnswerSoundToggle /><span className="quiz-eyebrow">知识试炼</span>{r?.title ?? title}</div>
    <p className="quiz-muted">先作答并按需记下思考，整组交卷后揭晓答案。各题独立分析，文字先显示，图示随后补齐。{tiers && ` 本组：${tiers}。`}</p>
    {attemptLine && <p className="quiz-attempt-line" role="status">{attemptLine}</p>}
    {attempts.error && <p className="quiz-attempt-error" role="alert">{attempts.error}</p>}
    {feedback && <div className="quiz-adaptation"><p><b>你的评价：</b>{feedback.comment}</p>
      {submitted ? <p><b>本题调整：</b>{feedback.adjustment}</p> : <p>交卷后查看本题调整说明。</p>}</div>}
    {!r && <p role="status">{rounds.error ? '练习记录未打开。' : '正在恢复本轮作答…'}</p>}
    {rounds.error && <p className="quiz-review-error" role="alert">{rounds.error} <button type="button" className="quiz-gen-btn" onClick={r ? rounds.save : rounds.reload}>重试保存 / 读取</button></p>}
    {rounds.recovery && <p role="status">发现本机未同步的草稿。<button type="button" className="quiz-gen-btn" onClick={rounds.restore}>恢复后核对</button></p>}
    {r && <>
      <div className="quiz-progress-label" role="status"><strong>第 {r.number} 轮 · {submitted ? '已交卷' : '作答中'}</strong><span>{answered} / {r.questions.length}</span></div>
      <progress className="quiz-progress" value={answered} max={r.questions.length} aria-label="已填写题目" />
      {r.questions.map((q, i) => <QuizQuestionItem key={`${r.id}-${i}`} q={q} index={i} topic={r.title} sessionId={r.sessionId ?? undefined}
        onAdapted={append} onComplete={() => {}} last={attempts.lastOf(i)} roundResponse={r.responses[i]!} disabled={rounds.acting || disabled}
        onDraftChange={(draft, thought) => rounds.change(i, draft, thought)} onRetryAnalysis={() => void rounds.retry(i)} />)}
      <div className="quiz-round-actions">
        {!submitted && <button type="button" className="quiz-submit" disabled={disabled || answered !== r.questions.length || rounds.acting || rounds.saving}
          onClick={() => void submit()}>{rounds.acting ? '正在交卷…' : '提交整组答案 · 逐题分析'}</button>}
        {submitted && r.latestId === r.id && !rounds.busy && <button type="button" className="quiz-gen-btn" disabled={rounds.acting || disabled} onClick={() => void rounds.next()}>再练一遍</button>}
        {rounds.busy && <button type="button" className="quiz-gen-btn" disabled={rounds.acting} onClick={() => void rounds.cancel()}>停止未完成的生成</button>}
        {r.previousId && <button type="button" className="quiz-gen-btn" disabled={rounds.acting || rounds.saving} onClick={() => void rounds.previous()}>查看上一轮</button>}
        {r.latestId !== r.id && <button type="button" className="quiz-gen-btn" disabled={rounds.acting} onClick={() => void rounds.latest()}>返回当前轮</button>}
        <span className="quiz-round-save" role="status">{submitted ? '答案、思考和已有分析已保存' : rounds.saving ? '正在保存…' : '输入自动保存 · 思考选填'}</span>
      </div>
      {submitted && <AnswerImpact verdict="complete" />}
      {rounds.streamError && <p className="quiz-muted" role="status">{rounds.streamError}</p>}
      {rounds.busy && <p className="quiz-muted">各题独立生成，可先阅读已出现的内容；离开页面后仍会继续保存。</p>}
    </>}
    {!recordId && <button type="button" className="quiz-gen-btn" onClick={() => { void rounds.flush().then(() => setHistory(true)).catch(() => undefined); }}>作答历史</button>}
    {history && <QuizRoundHistoryPanel onClose={() => { setHistory(false); rounds.reload(); }} renderRound={id => <QuizCard key={id} recordId={id} title="历史作答" questions={[]} compact />} />}
  </div>{followups.map(next => <QuizCard key={next.quizId} title={next.quiz.title ?? '调整后的练习'} questions={next.quiz.questions}
    quizId={next.quizId} feedback={next.quiz.feedback} onAdapted={append} origin={origin} sessionId={sessionId} />)}</>;
}
