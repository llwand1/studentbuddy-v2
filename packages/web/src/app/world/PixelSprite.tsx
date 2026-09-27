/**
 * world/PixelSprite — 字符画 → SVG 方块（同行同色合并成一条 rect）。
 * 用于 DOM 层的小角色（伙伴、Boss 头像），`crispEdges` 保证放大后仍是硬边像素。
 */
import type { Palette, SpriteMap } from '../hero/hero-sprites';

export function PixelSprite({ map, pal, className }: { map: SpriteMap; pal: Palette; className?: string }) {
  const w = Math.max(...map.map((r) => r.length));
  const runs: Array<{ x: number; y: number; n: number; c: string }> = [];
  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x]!;
      const c = pal[ch];
      if (!c) { x++; continue; }
      let n = 1;
      while (row[x + n] === ch) n++;
      runs.push({ x, y, n, c });
      x += n;
    }
  });
  return (
    <svg className={className} viewBox={`0 0 ${w} ${map.length}`} shapeRendering="crispEdges" aria-hidden="true">
      {runs.map((r) => <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.n} height={1} fill={r.c} />)}
    </svg>
  );
}
