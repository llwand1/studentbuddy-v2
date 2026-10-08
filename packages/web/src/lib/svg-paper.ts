import { SVG_NS } from './svg-allowlist';

/** 独立 SVG 也能读：主题变量实体化，不依赖宿主的夜间主题。 */
const PAPER_COLORS: Record<string, string> = {
  ink: '#20242c', 'ink-secondary': '#475569', 'ink-tertiary': '#64748b',
  bg: '#ffffff', surface: '#ffffff', sidebar: '#ffffff',
  line: '#cbd5e1', primary: '#b42335', 'primary-weak': '#fff1f2',
  success: '#276749', danger: '#b91c1c', gold: '#855900',
};

/** 参数已净化；只添加固定的纸面绘图属性，不引入不可信 HTML。 */
export function paperSvg(safe: string): string {
  if (!safe || typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return '';
  const resolved = safe.replace(/var\(\s*--sb-([\w-]+)(?:\s*,[^)]*)?\s*\)/g,
    (original: string, name: string) => PAPER_COLORS[name] ?? original);
  const doc = new DOMParser().parseFromString(resolved, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror')) return '';
  root.setAttribute('color', PAPER_COLORS.ink ?? '#20242c');
  if (!root.hasAttribute('fill')) root.setAttribute('fill', PAPER_COLORS.ink ?? '#20242c');
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const hasBox = box.length === 4 && box.every(Number.isFinite) && (box[2] ?? 0) > 0 && (box[3] ?? 0) > 0;
  const coords = hasBox ? box.map(String) : ['0', '0', '100%', '100%'];
  const first = root.firstElementChild;
  const attrs = { x: coords[0] ?? '0', y: coords[1] ?? '0', width: coords[2] ?? '100%', height: coords[3] ?? '100%' };
  const existingPaper = first?.localName === 'rect' && first.getAttribute('fill') === '#ffffff'
    && Object.entries(attrs).every(([key, value]) => first.getAttribute(key) === value);
  const paper = existingPaper ? first : doc.createElementNS(SVG_NS, 'rect');
  if (!paper) return '';
  for (const [key, value] of Object.entries(attrs)) paper.setAttribute(key, value);
  paper.setAttribute('fill', '#ffffff');
  paper.setAttribute('stroke', 'none');
  paper.setAttribute('pointer-events', 'none');
  paper.setAttribute('style', 'fill:#ffffff!important;stroke:none!important;opacity:1!important;filter:none!important');
  if (!existingPaper) root.insertBefore(paper, root.firstChild);
  return new XMLSerializer().serializeToString(root);
}
