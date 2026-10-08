import { readableMath } from '../../lib/math-text';
import './learning-reply.css';

export function MathFormula({ code, inline = false, closed = true }: { code: string; inline?: boolean; closed?: boolean }) {
  const text = closed ? readableMath(code) : null;
  if (inline) return <code className="md-inline-code" title={text === null ? '公式源码' : '公式'}>{text ?? '$' + code + '$'}</code>;
  if (!closed) return <div className="learning-formula">正在书写公式…</div>;
  return text === null
    ? <details className="learning-formula"><summary>公式源码（暂不支持此语法）</summary><pre><code>{code}</code></pre></details>
    : <figure className="learning-formula" aria-label="公式"><span className="learning-formula-label">公式</span><code>{text}</code></figure>;
}
