import { useEffect, useState, useSyncExternalStore } from 'react';
import { answerSoundEnabled, playAnswerSound, subscribeAnswerSound, toggleAnswerSound, type AnswerVerdict } from './answer-audio';
import './answer-impact.css';

/** Mount only for a real decision. Expired effects cannot replay when hidden chat returns. */
export function AnswerImpact({ verdict, event = verdict, audible = false }: {
  verdict: AnswerVerdict; event?: string | number; audible?: boolean;
}) {
  const [active, setActive] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    setActive(!media?.matches);
    if (audible) playAnswerSound(verdict);
    const timer = window.setTimeout(() => setActive(false), 1100);
    const change = () => { if (media?.matches) { window.clearTimeout(timer); setActive(false); } };
    media?.addEventListener?.('change', change);
    return () => { window.clearTimeout(timer); media?.removeEventListener?.('change', change); };
  }, [verdict, event, audible]);
  if (!active) return null;
  return <div key={event} className={`answer-impact is-${verdict}`} aria-hidden="true">
    <div className="answer-halo" /><i className="answer-slash" /><i className="answer-slash echo" />
    <svg className="answer-crest" viewBox="0 0 64 64" shapeRendering="crispEdges" focusable="false">
      <path className="answer-crest-ring" d="M24 4h16v4h12v12h4v24h-4v12H40v4H24v-4H12V44H8V20h4V8h12z" />
      <path className="answer-crest-mark" d={verdict === 'wrong' ? 'M20 20h6v6h12v-6h6v6h-6v12h6v6h-6v-6H26v6h-6v-6h6V26h-6z'
        : verdict === 'review' || verdict === 'partial' ? 'M28 16h8v20h-8zm0 28h8v8h-8z'
          : 'M16 30h8v8h8V26h8V14h8v20h-8v12H24v-8h-8z'} />
    </svg>
    <div className="answer-fragments">{Array.from({length:24}, (_, i) => <i key={i} />)}</div>
  </div>;
}

export function AnswerSoundToggle() {
  const enabled = useSyncExternalStore(subscribeAnswerSound, answerSoundEnabled, () => false);
  return <button type="button" className="answer-sound-toggle" aria-pressed={enabled} onClick={toggleAnswerSound}
    aria-label={`答题音效：${enabled ? '开' : '关'}`} title="只为真实作答播放短音效">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h3l4-3v10l-4-3H2z" />
      <path d={enabled ? 'M11 5v6m3-8v10' : 'M11 6l4 4m0-4l-4 4'} /></svg>
    <span>音效{enabled ? '开' : '关'}</span>
  </button>;
}
