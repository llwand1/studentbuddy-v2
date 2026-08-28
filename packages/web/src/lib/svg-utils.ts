// svg-utils.ts —— SVG 画图能力的纯函数层（port from v1 chat/svgUtils.ts + parseWidget.fixSvg）。
// 无 React 依赖，vitest node 环境可直接跑；```svg 围栏 → 自愈 → 净化 → 内联渲染。

/** 卡片可视宽度上限：超宽图一律钳到该值（等比缩放靠 viewBox）。 */
const MAX_SVG_W = 680;

/** 捕获组兜空：tsconfig 开了 noUncheckedIndexedAccess。 */
const g = (m: RegExpMatchArray, k: number): string => m[k] ?? '';

/** 字符串 → 数字，解析不出即 null（区分"没写"与"写了但不合法"两种降级路径）。 */
const num = (v: string): number | null => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** 提取文本中所有已闭合的 ```svg 围栏块（无围栏则空数组）。 */
export function extractSvgBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```svg\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = g(m, 1).replace(/\s+$/, '');
    if (body.trim()) out.push(body);
  }
  return out;
}

/** 从正在流式输入的 tail 中提取 SVG 主体（去掉开头的 ```svg 行）。 */
export function stripSvgFenceLine(tail: string): string {
  return tail.replace(/^```svg\s*\n?/i, '');
}

/** 是否已有闭合 </svg>（围栏未闭合但内容完整时可提前实时预览）。 */
export function hasClosedSvgTag(code: string): boolean {
  return /<\/svg\s*>/i.test(code);
}

export interface SvgSize {
  w: number | null;
  h: number | null;
}

/** 解析尺寸：只读根 <svg> 开标签，优先 width/height，其次 viewBox。 */
export function parseSvgSize(svg: string): SvgSize {
  const open = svg.match(/<svg\b[^>]*>/i);
  const root = open ? open[0] : '';
  const attr = (name: string): number | null => {
    const m = root.match(new RegExp(`\\b${name}\\s*=\\s*["']([0-9.]+)`, 'i'));
    return m ? num(g(m, 1)) : null;
  };
  let w = attr('width');
  let h = attr('height');
  if (w === null || h === null) {
    const vb = root.match(
      /viewBox\s*=\s*["']\s*([0-9.+-]+)[,\s]+([0-9.+-]+)[,\s]+([0-9.+-]+)[,\s]+([0-9.+-]+)\s*["']/i,
    );
    if (vb) {
      if (w === null) w = num(g(vb, 3));
      if (h === null) h = num(g(vb, 4));
    }
  }
  return { w, h };
}

/**
 * 内联渲染前净化：剥 <script>/<foreignObject>/<iframe>/<object>/<embed>、
 * 所有 on* 事件属性与 href 的 javascript: 协议；保留 SMIL/CSS 动画等正常绘图能力。
 */
export function sanitizeSvg(svg: string): string {
  if (typeof DOMParser !== 'undefined') {
    try {
      return sanitizeViaDom(svg);
    } catch {
      // 畸形 SVG → 回退正则路径：宁可慢也不漏净化
    }
  }
  return sanitizeViaRegex(svg);
}

/** DOM 遍历净化：O(n)，避开正则回溯把主线程钉死（v1 真机「窗口冻住几十秒」的根因）。 */
function sanitizeViaDom(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('malformed svg');
  doc.querySelectorAll('script, foreignObject, iframe, object, embed').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
        el.setAttribute(attr.name, '');
      }
    }
  });
  const root = doc.documentElement;
  return root ? new XMLSerializer().serializeToString(root) : svg;
}

/** 正则回退净化：用「不是闭合标签就线性吞」写法替代 [\s\S]*?，杜绝 catastrophic backtracking。 */
function sanitizeViaRegex(svg: string): string {
  let s = svg;
  const removeBlock = (tag: string): void => {
    const open = new RegExp('<' + tag + '\\b[^>]*>', 'gi');
    const block = new RegExp(
      '<' + tag + '\\b[^>]*>[^<]*(?:<(?!<\\/' + tag + '\\s*>)[^<]*)*<\\/' + tag + '\\s*>',
      'gi',
    );
    s = s.replace(block, '').replace(open, '');
  };
  for (const tag of ['script', 'foreignObject', 'iframe', 'object', 'embed']) removeBlock(tag);
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  s = s.replace(/(\s(?:xlink:)?href\s*=\s*["'])\s*javascript:[^"']*(["'])/gi, '$1$2');
  s = s.replace(/(\s[-\w:]*url\s*\(\s*["']?)\s*javascript:/gi, '$1');
  return s;
}

export interface SvgFix {
  code: string;
  fixed: boolean;
}

const BLACK = /(fill|stroke)\s*=\s*["'](?:#000(?:000)?|black)["']/gi;
const WHITE = /(fill|stroke)\s*=\s*["'](?:#fff(?:fff)?|white)["']/gi;

/**
 * L1 自愈：① 补 </svg> 闭合（流式半截图不再白屏）；② 钳宽 680 / 缺 viewBox 时合成；
 * ③ 纯黑纯白 fill/stroke 换成主题变量（深色主题下不再一团黑）。
 */
export function fixSvg(code: string): SvgFix {
  let s = (code || '').trim();
  if (!s) return { code: s, fixed: false };
  let fixed = false;

  if (/<svg[\s>]/i.test(s) && !/<\/svg\s*>/i.test(s)) {
    s += '</svg>';
    fixed = true;
  }

  const open = s.match(/<svg\b[^>]*>/i);
  if (open) {
    let tag = g(open, 0);
    const wm = tag.match(/\bwidth\s*=\s*["']([0-9.]+)/i);
    if (!/viewBox/i.test(tag)) {
      const hm = tag.match(/\bheight\s*=\s*["']([0-9.]+)/i);
      if (wm && hm) {
        tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${g(wm, 1)} ${g(hm, 1)}"`);
        s = s.replace(/<svg\b[^>]*>/i, tag);
        fixed = true;
      }
    }
    const vbW = tag.match(/viewBox\s*=\s*["']\s*[0-9.+-]+\s*[0-9.+-]+\s*([0-9.+-]+)/i);
    const w = wm ? num(g(wm, 1)) : vbW ? num(g(vbW, 1)) : null;
    if (w !== null && w > MAX_SVG_W) {
      tag = wm
        ? tag.replace(/\bwidth\s*=\s*["'][0-9.]+["']/i, `width="${MAX_SVG_W}"`)
        : tag.replace(/<svg\b/i, `<svg width="${MAX_SVG_W}"`);
      s = s.replace(/<svg\b[^>]*>/i, tag);
      fixed = true;
    }
    const themed = s.replace(BLACK, '$1="var(--sb-ink)"').replace(WHITE, '$1="var(--sb-bg)"');
    if (themed !== s) {
      s = themed;
      fixed = true;
    }
  }
  return { code: s, fixed };
}

/** 自愈 + 净化的常用组合（渲染前一次调用）。 */
export function prepareSvg(code: string): string {
  return sanitizeSvg(fixSvg(code).code);
}

/**
 * SVG 作为独立文档下载 / 新标签页打开（SvgPreviewCard 与 ChartCard 共用）。
 * 参数只应传**已净化**的 SVG：blob 文档的 Origin 等于本应用，直接开模型原始输出
 * 等于让里面的 <script> 拿着我们的写接口权限执行。
 */
export function openSvgDocument(safeSvg: string, mode: 'download' | 'open'): void {
  if (typeof document === 'undefined') return;
  try {
    const url = URL.createObjectURL(new Blob([safeSvg], { type: 'image/svg+xml;charset=utf-8' }));
    if (mode === 'download') {
      const a = document.createElement('a');
      a.href = url;
      a.download = `studentbuddy-${Date.now()}.svg`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  } catch {
    /* 静默：单机应用打开/下载失败不弹错 */
  }
}
