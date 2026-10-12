import { useMemo, useState } from 'react';
import type { CampfireOpener } from '@sb/shared';
import { AnswerSoundToggle } from '../feedback/AnswerImpact';
import { CompanionArt } from './FloatCompanion';
import { QuizCard } from '../quiz/QuizCard';
export function FloatQuiz({ opener, onFinish, onVerdict }: { opener: CampfireOpener; onFinish: (action: 'done' | 'skip' | 'snooze') => Promise<void>; onVerdict?: (correct: boolean) => void }) {
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const q = opener.question;
  const questions = useMemo(() => [{ type: 'single' as const, question: q.question, options: q.options, answer: [q.answer], explanation: q.explanation, material: opener.material }], [q, opener.material]);
  const finish = (action: 'done' | 'skip' | 'snooze') => {
    setBusy(true); setError('');
    void onFinish(action).catch(e => setError(e instanceof Error ? e.message : '操作失败，请重试')).finally(() => setBusy(false));
  };
  return <section className="desktop-quiz answer-surface" aria-label="定时练习题">
    <div className="desktop-quiz-scroll"><header><span className="sb-companion-portrait"><CompanionArt mood={choice === null ? 'question' : choice === q.answer ? 'celebrate' : 'encourage'} /></span><span>✦ 篝火来信</span><small>{opener.scope || '学习方向'} · {q.topic}</small></header>
      <QuizCard title={q.topic} questions={questions} quizId={`desktop-${opener.id}`} origin="desktop" compact disabled={busy}
        onRoundChange={round => setChoice(round?.state === 'submitted' ? round.responses[0]?.draft.picked[0] ?? null : null)}
        onSubmitted={round => onVerdict?.(round.responses[0]?.result?.verdict === 'correct')} />
      {error && <p role="alert" className="desktop-error">{error}</p>}
    </div><footer><AnswerSoundToggle />{choice === null ? <><button type="button" disabled={busy} onClick={() => finish('snooze')}>两分钟后</button><button type="button" disabled={busy} onClick={() => finish('skip')}>跳过</button></>
      : <button type="button" className="desktop-primary" disabled={busy} onClick={() => finish('done')}>完成 · 收起题卡 ✓</button>}</footer>
  </section>;
}
