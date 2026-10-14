import { memo, useEffect, useId, useState } from 'react';
import { renderDiagram, uniqueDiagramIds } from '../../lib/diagram-render';
import { SvgPreviewCard } from './SvgPreviewCard';

export const MermaidDiagram = memo(function MermaidDiagram({ code, closed }: { code: string; closed: boolean }) {
  const [result, setResult] = useState<{ code: string; svg: string | null; error?: string }>();
  const [attempt, retry] = useState(0);
  const id = useId().replace(/:/g, '');
  useEffect(() => {
    if (!closed) return;
    let active = true;
    void renderDiagram(code).then(svg => { if (active) setResult({ code, svg }); },
      (error: unknown) => { if (active) setResult({ code, svg: null, error: error instanceof Error && error.message.startsWith('图解') ? error.message : '图解语法或布局未完成' }); });
    return () => { active = false; };
  }, [code, closed, attempt]);
  if (!closed || result?.code !== code) return <div className="math-pending" role="status">{closed ? '正在整理图解…' : '正在书写图解…'}</div>;
  if (!result.svg) return <details className="math-fallback" open><summary>图解暂未排版，保留原文</summary>
    <p>{result.error} <button type="button" onClick={() => { setResult(undefined); retry(n => n + 1); }}>重试排版</button></p><pre><code>{code}</code></pre></details>;
  // Cached SVGs need per-instance IDs so arrows/text paths cannot reference a different diagram.
  const svg = uniqueDiagramIds(result.svg, id);
  return <SvgPreviewCard code={svg} streaming={false} label="图解" title="知识图解" sourceCode={code} />;
});
