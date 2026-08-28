// chart-utils.ts —— 零依赖图表 DSL（```chart 围栏）：JSON 容错解析 + 纯字符串出 SVG。
// JSON 容错层（剥注释/尾逗号）port from v1 parseWidget.ts；渲染层自产 SVG——文本节点一律
// 经 esc() 转义、颜色全走 tokens.css 变量（--sb-primary 单色相 + 透明度梯度），node 可单测。

export type ChartType = 'bar' | 'line' | 'pie';

export interface ChartSpec {
  type: ChartType;
  title: string;
  labels: string[];
  values: number[];
}

export interface FixResult {
  code: string;
  fixed: boolean;
}

/** 柱/折线最多点数：再多可读性崩，该用表格。 */
const MAX_POINTS = 31;
/** 饼图扇区上限：透明度梯度再多分不出块。 */
const MAX_PIE = 8;
/** 单标签截断长度。 */
const MAX_LABEL = 12;
/** 饼图扇区透明度梯度（不加第二强调色）。 */
const PIE_OPACITY = [1, 0.82, 0.66, 0.52, 0.4, 0.3, 0.22, 0.15];

const W = 680;

/**
 * 容错剥 JSON 注释（// 行注释 + 块注释），不破坏字符串内容或协议 URL。
 * 纯状态机扫描：跟踪字符串边界，避免正则回溯与 `://` 误伤。port from v1。
 */
export function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inStr: string | null = null; // '"' | "'" | '`'
  while (i < n) {
    const c = src[i] ?? '';
    const c2 = c + (src[i + 1] ?? '');
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c2 === '/*') {
      let j = i + 2;
      while (j < n && !((src[j] ?? '') === '*' && (src[j + 1] ?? '') === '/')) j++;
      i = Math.min(j + 2, n);
      continue;
    }
    if (c2 === '//') {
      if (i > 0 && src[i - 1] === ':') {
        out += '//';
        i += 2;
        continue;
      }
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

/** L1 修复：剥注释 + 尾逗号。不 parse，解析失败由调用方降级。 */
export function fixJson(code: string): FixResult {
  const cleaned = stripTrailingCommas(stripJsonComments(code));
  return { code: cleaned, fixed: cleaned !== code };
}

/** 解析 ```chart 围栏 JSON → ChartSpec；任何不合法一律 null（上游降级源码显示）。 */
export function parseChart(raw: string): ChartSpec | null {
  let obj: unknown = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    try {
      obj = JSON.parse(fixJson(raw).code);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== 'bar' && o.type !== 'line' && o.type !== 'pie') return null;
  if (!Array.isArray(o.labels) || !Array.isArray(o.values)) return null;
  const rawLabels: unknown[] = o.labels;
  const rawValues: unknown[] = o.values;
  if (rawLabels.length !== rawValues.length) return null;
  const n = rawValues.length;
  if (n < 1 || (o.type === 'pie' ? n > MAX_PIE : n > MAX_POINTS)) return null;
  const values: number[] = [];
  for (const v of rawValues) {
    // 学习数据（时长/正确率/数量）没有负值语义：负数当坏输入降级，不做坐标魔法
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    values.push(v);
  }
  if (o.type === 'pie' && values.reduce((a, b) => a + b, 0) <= 0) return null;
  const labels = rawLabels.map((l) => String(l).slice(0, MAX_LABEL));
  const title = typeof o.title === 'string' ? o.title.slice(0, 40) : '';
  return { type: o.type, title, labels, values };
}

/** XML 文本转义：标签/类目来自模型输出，进 SVG 文本节点前必须转义。 */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const r2 = (v: number): number => Math.round(v * 100) / 100;
const fmtV = (v: number): string => (Number.isInteger(v) ? String(v) : String(r2(v)));

/** y 轴上限取 1/2/5×10^k 的「好看」整数。 */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * pow;
}

function elText(
  x: number,
  y: number,
  str: string,
  opts: { size?: number; fill?: string; anchor?: 'middle' | 'start' | 'end'; weight?: number },
): string {
  const a = [
    `x="${r2(x)}"`,
    `y="${r2(y)}"`,
    `font-size="${opts.size ?? 11}"`,
    `fill="${opts.fill ?? 'var(--sb-ink-secondary)'}"`,
  ];
  if (opts.anchor) a.push(`text-anchor="${opts.anchor}"`);
  if (opts.weight) a.push(`font-weight="${opts.weight}"`);
  return `<text ${a.join(' ')}>${str}</text>`;
}

function svgRoot(h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" font-family="inherit">`;
}

/** 柱状/折线：共享坐标系，差异只在数据标记。 */
function renderXY(spec: ChartSpec, titleH: number): string {
  const H = titleH + 234;
  const top = titleH + 8;
  const bottom = H - 30;
  const left = 46;
  const right = W - 16;
  const plotW = right - left;
  const plotH = bottom - top;
  const n = spec.values.length;
  const maxV = niceMax(Math.max(...spec.values));
  const yOf = (v: number): number => bottom - (v / maxV) * plotH;
  const xCenter = (i: number): number =>
    spec.type === 'line'
      ? n === 1
        ? left + plotW / 2
        : left + (plotW * i) / (n - 1)
      : left + (plotW * (i + 0.5)) / n;

  const p: string[] = [svgRoot(H)];
  if (spec.title) {
    p.push(elText(W / 2, titleH - 12, esc(spec.title), { anchor: 'middle', size: 13, weight: 600, fill: 'var(--sb-ink)' }));
  }
  for (const gv of [maxV, maxV / 2]) {
    p.push(`<line x1="${left}" y1="${r2(yOf(gv))}" x2="${right}" y2="${r2(yOf(gv))}" stroke="var(--sb-line)" stroke-dasharray="3 3"/>`);
    p.push(elText(left - 6, yOf(gv) + 4, fmtV(gv), { anchor: 'end', fill: 'var(--sb-ink-tertiary)' }));
  }
  p.push(`<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="var(--sb-line)"/>`);

  if (spec.type === 'bar') {
    const slot = plotW / n;
    const barW = Math.min(slot * 0.6, 48);
    spec.values.forEach((v, i) => {
      const x = left + slot * i + (slot - barW) / 2;
      const y = yOf(v);
      const h = v > 0 ? Math.max(bottom - y, 1) : 0;
      p.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(barW)}" height="${r2(h)}" rx="2" fill="var(--sb-primary)"/>`);
      p.push(elText(x + barW / 2, y - 4, fmtV(v), { anchor: 'middle' }));
    });
  } else {
    const pts = spec.values.map((v, i) => `${r2(xCenter(i))},${r2(yOf(v))}`).join(' ');
    p.push(`<polyline points="${pts}" fill="none" stroke="var(--sb-primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    spec.values.forEach((v, i) => {
      p.push(`<circle cx="${r2(xCenter(i))}" cy="${r2(yOf(v))}" r="3" fill="var(--sb-primary)"/>`);
      if (n <= 12) p.push(elText(xCenter(i), yOf(v) - 8, fmtV(v), { anchor: 'middle' }));
    });
  }

  const xStep = Math.ceil(n / 10);
  spec.labels.forEach((lb, i) => {
    if (i % xStep === 0) p.push(elText(xCenter(i), bottom + 16, esc(lb), { anchor: 'middle' }));
  });
  p.push('</svg>');
  return p.join('');
}

/** 饼图：左侧扇区（单色相透明度梯度）+ 右侧图例（类目 数值 占比）。 */
function renderPie(spec: ChartSpec, titleH: number): string {
  const H = titleH + 236;
  const cx = 150;
  const cy = titleH + 118;
  const r = 88;
  const total = spec.values.reduce((a, b) => a + b, 0);
  const p: string[] = [svgRoot(H)];
  if (spec.title) {
    p.push(elText(W / 2, titleH - 12, esc(spec.title), { anchor: 'middle', size: 13, weight: 600, fill: 'var(--sb-ink)' }));
  }
  let ang = -Math.PI / 2;
  spec.values.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    const a2 = ang + sweep;
    const op = PIE_OPACITY[i] ?? 0.15;
    const paint = `fill="var(--sb-primary)" fill-opacity="${op}" stroke="var(--sb-surface)" stroke-width="1.5"`;
    if (sweep >= Math.PI * 2 - 1e-6) {
      p.push(`<circle cx="${cx}" cy="${cy}" r="${r}" ${paint}/>`);
    } else {
      const x1 = r2(cx + r * Math.cos(ang));
      const y1 = r2(cy + r * Math.sin(ang));
      const x2 = r2(cx + r * Math.cos(a2));
      const y2 = r2(cy + r * Math.sin(a2));
      p.push(`<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z" ${paint}/>`);
    }
    ang = a2;
  });
  let ly = cy - ((spec.values.length - 1) * 22) / 2;
  spec.values.forEach((v, i) => {
    const pct = Math.round((v / total) * 100);
    p.push(`<rect x="310" y="${r2(ly - 9)}" width="11" height="11" rx="2" fill="var(--sb-primary)" fill-opacity="${PIE_OPACITY[i] ?? 0.15}"/>`);
    p.push(elText(330, ly + 1, `${esc(spec.labels[i] ?? '')} ${fmtV(v)}（${pct}%）`, { size: 12.5, fill: 'var(--sb-ink)' }));
    ly += 22;
  });
  p.push('</svg>');
  return p.join('');
}

/** ChartSpec → 完整 SVG 字符串（自产内容，仍会过 prepareSvg 净化后注入）。 */
export function renderChartSvg(spec: ChartSpec): string {
  const titleH = spec.title ? 34 : 8;
  return spec.type === 'pie' ? renderPie(spec, titleH) : renderXY(spec, titleH);
}
