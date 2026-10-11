import { useState } from 'react';
import type { CampfireOpener } from '@sb/shared';
import { MathText } from '../chat/MathText';
import { Markdown } from '../chat/Markdown';
import { AnswerImpact, AnswerSoundToggle } from '../feedback/AnswerImpact';
export function FloatQuiz({ opener, onFinish }: { opener: CampfireOpener; onFinish: (action: 'done' | 'skip' | 'snooze') => Promise<void> }) {
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const q = opener.question;
  const finish = (action: 'done' | 'skip' | 'snooze') => {
    setBusy(true); setError('');
    void onFinish(action).catch(e => setError(e instanceof Error ? e.message : '操作失败，请重试')).finally(() => setBusy(false));
  };
  return <section className="desktop-quiz answer-surface" aria-label="定时练习题">
    {choice !== null && <AnswerImpact verdict={choice === q.answer ? 'correct' : 'wrong'} audible />}
    <div className="desktop-quiz-scroll"><header><span>✦ 篝火来信</span><small>{opener.scope || '学习方向'} · {q.topic}</small></header>
      <h2><MathText text={q.question} /></h2><div className="desktop-quiz-options" role="group" aria-label="选择答案">
        {q.options.map((option, i) => <button key={i} type="button" disabled={choice !== null || busy} aria-pressed={choice === i}
          className={`${choice !== null && i === q.answer ? 'is-correct' : ''} ${choice === i && i !== q.answer ? 'is-wrong' : ''}`} onClick={() => setChoice(i)}>
          <b>{String.fromCharCode(65 + i)}</b><span><MathText text={option} /></span>{choice !== null && i === q.answer && <span>✓</span>}</button>)}
      </div>{choice !== null && <div className="desktop-quiz-explanation" aria-live="polite"><strong>{choice === q.answer ? '答对了 · 火花点亮！' : `正确答案是 ${String.fromCharCode(65 + q.answer)}，再记牢一点。`}</strong><Markdown text={q.explanation} /></div>}
      {error && <p role="alert" className="desktop-error">{error}</p>}
    </div><footer><AnswerSoundToggle />{choice === null ? <><button type="button" disabled={busy} onClick={() => finish('snooze')}>两分钟后</button><button type="button" disabled={busy} onClick={() => finish('skip')}>跳过</button></>
      : <button type="button" className="desktop-primary" disabled={busy} onClick={() => finish('done')}>完成 · 收起题卡 ✓</button>}</footer>
  </section>;
}
