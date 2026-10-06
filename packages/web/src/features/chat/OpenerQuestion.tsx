import { useEffect, useState } from 'react';
import { openerChatPrompt, type CampfireOpener } from '@sb/shared';

export function OpenerQuestion({ opener, onPick, onNext, blocked }: {
  opener: CampfireOpener;
  onPick: (text: string) => void;
  onNext: () => void;
  blocked: boolean;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const [arriving, setArriving] = useState(true);
  const q = opener.question;
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setArriving(false); return; }
    const timer = window.setTimeout(() => setArriving(false), 2900);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <section className={`opener-quest${arriving ? ' opener-arriving' : ''}`} aria-label="本次热身题" aria-busy={arriving}>
      <div className="opener-summon" aria-hidden="true"><span /><span /><span /><span /><span /><span /></div>
      <header className="opener-quest-head"><span>QUEST · 热身任务</span><span className="opener-topic">{q.topic}</span></header>
      <h2 className="opener-stem">{q.question}</h2>
      <div className="opener-options" role="group" aria-label="选择热身题答案">
        {q.options.map((option, index) => {
          const correct = choice !== null && index === q.answer;
          const wrong = choice === index && index !== q.answer;
          return <button type="button" key={index} className={`opener-option${correct ? ' opener-correct' : ''}${wrong ? ' opener-wrong' : ''}`} aria-pressed={choice === index} disabled={arriving || blocked} onClick={() => setChoice(index)}>
            <span className="opener-letter">{String.fromCharCode(65 + index)}</span><span className="opener-option-text">{option}</span>
            {correct && <span className="opener-verdict">✓ <span>正确答案</span></span>}
            {wrong && <span className="opener-verdict">↗ <span>再想想</span></span>}
          </button>;
        })}
      </div>
      {choice !== null && <div className="opener-explanation" aria-live="polite"><p className="opener-feedback">{choice === q.answer ? '答对了，火花亮起来了。' : `这道题选 ${String.fromCharCode(65 + q.answer)}，一起看看为什么。`}</p><p>{q.explanation}</p></div>}
      <footer className="opener-quest-actions"><button type="button" className="opener-next" disabled={blocked} onClick={onNext}>↻ 换一道</button><button type="button" className="opener-talk" disabled={arriving || blocked} onClick={() => onPick(openerChatPrompt(q, choice))}>聊聊为什么 →</button></footer>
    </section>
  );
}
