import { diagramSvg } from './diagram-svg';
const cache = new Map<string, Promise<string>>();
let sequence = 0;
let runtime: Promise<typeof import('mermaid').default> | undefined;

export function normalizeDiagramSource(source: string): string {
  if (!/^\s*(?:flowchart|graph)\b/.test(source)) return source;
  // Flowchart labels containing parentheses need quotes. Add syntax delimiters only;
  // never rewrite label content, relationships, mathematical values or stored source.
  return source.replace(/(^|[\s>;|])([A-Za-z_][\w-]*)\[([^\]\n"\\[]+)\]/g,
    (_, before: string, id: string, label: string) => `${before}${id}["${label}"]`);
}

export function uniqueDiagramIds(svg: string, suffix: string): string {
  const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1] ?? '');
  const occurrences = new Map<string, number>();
  let unique = svg.replace(/\bid="([^"]+)"/g, (_, id: string) => {
    const count = occurrences.get(id) ?? 0;
    occurrences.set(id, count + 1);
    return `id="${id}-${suffix}${count ? '-'+count : ''}"`;
  });
  for (const id of [...new Set(ids)].sort((a, b) => b.length - a.length)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    unique = unique.replace(new RegExp(`#${escaped}(?=[\\s).,:{}\\]"']|$)`, 'g'), `#${id}-${suffix}`);
  }
  return unique;
}

// Reject resources/config before Mermaid creates its temporary DOM, not just after rendering.
export function safeDiagramSource(source: string): boolean {
  return source.length <= 16000 && !/^\s*---/.test(source)
    && !/%%\s*\{|\b(?:https?:|data:|javascript:|file:)|url\s*\(|<|\b(?:click|href|img|image|icon|classDef|style)\b/i.test(source);
}

export function renderDiagram(source: string): Promise<string> {
  if (!safeDiagramSource(source)) return Promise.reject(new Error('diagram source rejected'));
  const existing = cache.get(source);
  if (existing) return existing;
  runtime ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      theme: 'default', htmlLabels: false, maxTextSize: 16000, maxEdges: 160,
      flowchart: { htmlLabels: false, useMaxWidth: false },
      themeVariables: { fontFamily: 'system-ui, sans-serif', fontSize: '18px',
        primaryColor: '#edf3fb', primaryTextColor: '#202c3a', primaryBorderColor: '#647c9c',
        lineColor: '#53677f', secondaryColor: '#f2edfa', tertiaryColor: '#e8f4ef' },
    });
    return mermaid;
  }).catch(error => { runtime = undefined; throw error; });
  const result = runtime.then(async mermaid => {
    const { svg } = await mermaid.render(`sb-diagram-${++sequence}`, normalizeDiagramSource(source));
    return diagramSvg(svg);
  });
  if (cache.size >= 16) cache.delete(cache.keys().next().value ?? '');
  cache.set(source, result);
  void result.catch(() => { if (cache.get(source) === result) cache.delete(source); });
  return result;
}
