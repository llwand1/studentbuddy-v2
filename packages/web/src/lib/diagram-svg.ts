/** Normalize library output before the unchanged SVG firewall. Never called on raw model SVG. */
export function diagramSvg(svg: string): string {
  // Mermaid includes these animations even for static graphs. The SVG firewall rejects all
  // @ rules; remove this known library rule so ordinary scoped colors/fonts survive.
  const staticSvg = svg.replace(/@(?:-webkit-)?keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/gi, '');
  const doc = new DOMParser().parseFromString(staticSvg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('invalid diagram output');
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box.every(Number.isFinite)) {
    root.setAttribute('width', String(box[2]));
    root.setAttribute('height', String(box[3]));
  }
  for (const label of root.querySelectorAll('text, tspan')) {
    label.setAttribute('fill', '#202c3a');
    label.setAttribute('style', 'fill:#202c3a;font-family:system-ui,sans-serif;font-size:18px');
  }
  for (const shape of root.querySelectorAll('.mindmap-node .node-bkg, .mindmap-node > circle')) {
    shape.setAttribute('style', 'fill:#edf3fb;stroke:#647c9c;stroke-width:1.5px');
  }
  for (const label of root.querySelectorAll('.mindmap-node.section-root text')) {
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('style', `${label.getAttribute('style')};text-anchor:middle`);
  }
  return new XMLSerializer().serializeToString(root);
}
