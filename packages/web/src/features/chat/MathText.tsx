import { memo, useMemo } from 'react';
import { renderMath } from '../../lib/math-render';
import 'katex/dist/katex.min.css';
import './math-reading.css';

// Compact, non-interactive math for option buttons, headings and reference answers.
// Plain text stays plain, and code examples shield their contents from math parsing.
const TOKENS = /```[^\n]*\n[\s\S]*?(?:```|$)|`[^`\n]+`|\\\$|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([^\n]+?\\\)|\$(?:[A-Za-z\\][^$\n]*|[-+]?\d[^$\n]*[=+\-×÷^_][^$\n]*|[-+]?\d+(?:\.\d+)?)\$/g;

export const MathText = memo(function MathText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const output: Array<{ text: string; html?: string; display?: boolean }> = [];
    let end = 0;
    for (const match of text.matchAll(TOKENS)) {
      output.push({ text: text.slice(end, match.index) });
      const token = match[0];
      end = match.index + token.length;
      const fenced = /^```(?:math|latex|tex)\s*\n([\s\S]*?)```$/.exec(token);
      const display = token.startsWith('$$') || token.startsWith('\\[') || !!fenced;
      const formula = fenced?.[1] ?? (display ? token.slice(2, -2) : token.startsWith('\\(') ? token.slice(2, -2) : token.slice(1, -1));
      const code = token.startsWith('`') && !fenced;
      const html = !code && token !== '\\$' ? renderMath(formula, display) : null;
      output.push(html ? { text: token, html, display } : { text: token === '\\$' ? '$' : token });
    }
    output.push({ text: text.slice(end) });
    return output;
  }, [text]);
  return <span className="math-text">{parts.map((part, index) => part.html
    ? <span key={index} className={part.display ? 'math-text-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: part.html }}/>
    : part.text)}</span>;
});
