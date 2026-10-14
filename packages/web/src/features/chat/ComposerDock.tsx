import { useEffect, useId, useState, type ReactNode } from 'react';
import { OPEN_COMPOSER } from '../desktop/desktop-input';

/** Folding changes visibility only: text, attachments and tool editor state remain mounted. */
export function ComposerDock({ busy, draft, onStop, children }: { busy: boolean; draft: boolean; onStop: () => void; children: ReactNode }) {
  const [folded, setFolded] = useState(false);
  const id = useId();
  useEffect(() => { const open = () => setFolded(false); window.addEventListener(OPEN_COMPOSER, open); return () => window.removeEventListener(OPEN_COMPOSER, open); }, []);
  return <div className={`composer-dock${folded ? ' is-folded' : ''}`}>
    <div className="composer-dock-handle">
      <button type="button" className="composer-fold" aria-expanded={!folded} aria-controls={id}
        onClick={() => setFolded((value) => !value)}>
        {folded ? `展开输入${draft ? ' · 有草稿' : ''}` : '收起输入'}
      </button>
      {folded && busy && <button type="button" className="composer-fold-stop" onClick={onStop}>停止生成</button>}
    </div>
    <div id={id} className="composer-dock-body" hidden={folded}>{children}</div>
  </div>;
}
