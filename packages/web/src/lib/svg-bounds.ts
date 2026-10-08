/** 已净化的图偶尔画出视口；原生测量避免猜字体、路径或变换的几何含义。 */
export function fitSvgBounds(root: Element): void {
  if (typeof document === 'undefined' || !document.body) return;
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const [x = 0, y = 0, w = 0, h = 0] = box;
  if (box.length !== 4 || !box.every(Number.isFinite) || w <= 0 || h <= 0) return;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:680px;visibility:hidden;pointer-events:none';
  try {
    const svg = document.importNode(root, true) as SVGSVGElement;
    if (typeof svg.getBBox !== 'function') return;
    host.attachShadow({ mode: 'closed' }).append(svg);
    document.body.append(host);
    const b = svg.getBBox();
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) return;
    const left = b.x < x - .01 ? b.x - 8 : x;
    const top = b.y < y - .01 ? b.y - 8 : y;
    const right = b.x + b.width > x + w + .01 ? b.x + b.width + 8 : x + w;
    const bottom = b.y + b.height > y + h + .01 ? b.y + b.height + 8 : y + h;
    if (right - left > 10000 || bottom - top > 10000) return;
    if (left !== x || top !== y || right !== x + w || bottom !== y + h) {
      root.setAttribute('viewBox', [left, top, right - left, bottom - top].join(' '));
      root.setAttribute('width', String(Math.min(680, right - left)));
      root.removeAttribute('height');
    }
  } catch { /* 残缺图形或浏览器无测量能力时保留原视口。 */ }
  finally { host.remove(); }
}
