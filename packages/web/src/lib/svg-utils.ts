// svg-utils.ts —— SVG 画图能力的纯函数层（port from v1 chat/svgUtils.ts + parseWidget.fixSvg）。
// 无 React 依赖；```svg 围栏 → 自愈（fixSvg）→ 白名单净化（svg-sanitize.ts，需 DOM）→ 内联渲染。
import { sanitizeSvgDom } from './svg-sanitize';

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
 * 内联渲染前净化：**白名单**净化器（`svg-sanitize.ts`）——元素 / 属性 / 属性值 / CSS 四层都是「没登记不进」，
 * `<image>`/`<feImage>`/外链 `href`/`url(https://…)` 这类会让本机向外发请求的一律不进
 * （模型产出的图里一个外链就是一枚信标：泄露用户 IP 与「本机会跑 studentbuddy」这一事实）。
 *
 * 输出是良构 XML：innerHTML 注入点与 blob: 独立文档（下载 / 新窗口）读到的是同一棵树。
 * 无 DOM 环境（纯 node）返回空串：宁可不画，也不让一张没审过的图进 innerHTML——旧版在这里退回弱正则，
 * 那条路径只在测试里跑过、从没在浏览器里跑过，却让人误以为「没有 DOM 也安全」。
 */
export function sanitizeSvg(svg: string): string {
  return sanitizeSvgDom(svg);
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
