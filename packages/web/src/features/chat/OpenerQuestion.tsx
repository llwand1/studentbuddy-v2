import { useEffect, useMemo, useRef, useState } from 'react';
import { openerChatPrompt, type CampfireOpener, type QuizFeedbackResult } from '@sb/shared';
import { AnswerSoundToggle } from '../feedback/AnswerImpact';
import { QuizCard } from '../quiz/QuizCard';

export function OpenerQuestion({ opener, onPick, onNext, blocked }: {
  opener: CampfireOpener;
  onPick: (text: string) => void;
  onNext: () => void;
  blocked: boolean;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const [followups, setFollowups] = useState<QuizFeedbackResult[]>([]);
  const append = (next: QuizFeedbackResult) => setFollowups(prev => [...prev, next]);
  const [arriving, setArriving] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const optionsRef = useRef<HTMLDivElement>(null);
  const q = opener.question;
  const feedbackQuestion = useMemo(() => ({ type: 'single' as const, question: q.question, options: q.options, answer: [q.answer], explanation: q.explanation, material: opener.material }), [q, opener.material]);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (reduce?.matches) return;
    const timer = window.setTimeout(() => setArriving(false), 2100);
    const change = () => { if (reduce?.matches) { window.clearTimeout(timer); setArriving(false); } };
    reduce?.addEventListener?.('change', change);
    return () => { window.clearTimeout(timer); reduce?.removeEventListener?.('change', change); };
  }, []);
  return (
    <><section className={`opener-quest answer-surface${arriving ? ' opener-arriving' : ''}`} aria-label="本次热身题" aria-busy={arriving}>
      <div className="opener-summon" aria-hidden="true"><i className="opener-sigil" /><i className="opener-beam" /><i className="opener-scan" /><span /><span /><span /><span /><span /><span /></div>
      <header className="opener-quest-head"><span>QUEST · 热身任务</span><span className="opener-topic">{q.topic}</span></header>
      <div ref={optionsRef}><QuizCard title={q.topic} questions={[feedbackQuestion]} quizId={`opener-${opener.id}`} origin="arrival" compact disabled={arriving || blocked}
        onAdapted={append} onRoundChange={round => setChoice(round?.state === 'submitted' ? round.responses[0]?.draft.picked[0] ?? null : null)} /></div>
      <footer className="opener-quest-actions"><button type="button" className="opener-next" disabled={blocked} onClick={onNext}>↻ 换一道</button><AnswerSoundToggle />
        {arriving && <button type="button" className="opener-direct" disabled={blocked} onClick={() => {
          setArriving(false); window.requestAnimationFrame(() => optionsRef.current?.querySelector('button')?.focus());
        }}>直接作答 ↓</button>}
        <button type="button" className="opener-talk" disabled={arriving || blocked || choice === null} onClick={() => onPick(openerChatPrompt(q, choice))}>聊聊为什么 →</button></footer>
    </section>{followups.map(next => <QuizCard key={next.quizId} title={next.quiz.title ?? '调整后的热身'} questions={next.quiz.questions}
      quizId={next.quizId} feedback={next.quiz.feedback} onAdapted={append} />)}</>
  );
}
