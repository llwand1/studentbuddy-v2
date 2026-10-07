/** 篝火开场：本次现场召题，题到后才播放像素卷轴入场（CHAT-UX-SPEC §2.10）。 */
import { PixelScene } from './PixelScene';
import { useExamScope } from '../exam/useExamScope';
import { useCampfireOpener } from './useCampfireOpener';
import { OpenerQuestion } from './OpenerQuestion';
import './campfire-opener.css';

export function Welcome({ onPick, blocked = false, onAsk }: {
  onPick: (text: string) => void;
  blocked?: boolean;
  onAsk?: () => void;
}) {
  const exam = useExamScope();
  const scopeKey = `${exam.on}:${exam.summary}`;
  const opener = useCampfireOpener(scopeKey, !blocked && !exam.loading);
  return (
    <div className="welcome welcome-campfire">
      <p className="welcome-eyebrow">CAMPFIRE · 篝火营地</p>
      <PixelScene />
      <p className="welcome-hi">先来一道，聊起来就容易了。</p>
      <p className="welcome-sub">{exam.on && exam.summary ? `在${exam.summary}范围内，先热个身。` : '从一个小问题，开启今天的冒险。'}</p>
      <div className="opener-stage">
        {opener.status === 'ready' && opener.value ? <OpenerQuestion key={opener.value.id} opener={opener.value} onPick={onPick} onNext={opener.retry} blocked={blocked} />
          : <div className={`opener-pending${opener.status === 'error' ? ' opener-failed' : ''}`} role="status" aria-live="polite">
            <div className="opener-rune" aria-hidden="true"><span /><span /><span /><span /></div>
            <p>{blocked ? '正在开启对话…' : opener.status === 'error' ? '这次召题没有完成' : '篝火正在召来一道新题…'}</p>
            {opener.status === 'error' ? <><p className="opener-error">{opener.error}</p><button type="button" className="opener-retry" onClick={opener.retry}>重新召题</button></> : <p className="opener-loading-hint">也可以直接在下面问，边走边聊。</p>}
          </div>}
      </div>
      <button type="button" className="opener-own" disabled={blocked} onClick={onAsk}>我有自己的问题 ↓</button>
    </div>
  );
}
