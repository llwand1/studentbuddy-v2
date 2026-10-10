import katex from 'katex';

// KaTeX generates the markup; model-authored HTML is never passed to innerHTML.
const cache = new Map<string, string | null>();
const FORBIDDEN = /\\(?:href|url|includegraphics|html\w*|class|style|id)\b/i;

export function renderMath(code: string, display: boolean): string | null {
  if (!code.trim() || code.length > 12000 || FORBIDDEN.test(code)) return null;
  const key = `${display ? 'D' : 'I'}:${code}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let html: string | null = null;
  try {
    html = katex.renderToString(code, {
      displayMode: display, fleqn: display, output: 'htmlAndMathml',
      throwOnError: true, trust: false, maxExpand: 1000, maxSize: 20,
      macros: {}, globalGroup: false,
      strict: (kind) => ['unicodeTextInMathMode', 'unknownSymbol'].includes(kind) ? 'ignore' : 'error',
    });
  } catch { /* Preserve the original source rather than guessing a calculation. */ }
  if (cache.size >= 96) cache.delete(cache.keys().next().value ?? '');
  cache.set(key, html);
  return html;
}
