import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { renderMath } from '../../lib/math-render';
import 'katex/dist/katex.min.css';
import './math-reading.css';

export const MathFormula = memo(function MathFormula({ code, inline = false, closed = true }: {
  code: string; inline?: boolean; closed?: boolean;
}) {
  const html = useMemo(() => closed ? renderMath(code, !inline) : null, [code, inline, closed]);
  const [large, setLarge] = useState(false);
  const [copyState, setCopyState] = useState('复制公式');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopyState('已复制'); }
    catch { setCopyState('请选中源码复制'); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState('复制公式'), 1800);
  };
  if (inline) return html
    ? <span className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />
    : <code className="math-source" title="公式源码">{`$${code}$`}</code>;
  if (!closed) return <div className="math-pending" role="status">正在书写公式…</div>;
  if (!html) return <details className="math-fallback" open>
    <summary>公式暂未排版，保留原式</summary><pre><code>{code}</code></pre>
  </details>;
  const aligned = /\\begin\{(?:aligned|alignedat|align\*?|gathered|gather\*?)\}/.test(code);
  return <figure className={`math-paper${large ? ' math-paper-large' : ''}`} aria-label={aligned ? '逐行推导' : '公式'}>
    <figcaption className="math-paper-head">
      <span className="math-paper-label">{aligned ? '逐行推导' : '公式'}</span>
      <span className="math-paper-actions">
        <button type="button" onClick={() => void copy()}>{copyState}</button>
        <button type="button" aria-pressed={large} onClick={() => setLarge(v => !v)}>{large ? '恢复' : '放大'}</button>
      </span>
    </figcaption>
    <div className="math-paper-scroll" role="region" aria-label="公式阅读区，可横向滚动" tabIndex={0}>
      <div className="math-paper-ink" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  </figure>;
});
