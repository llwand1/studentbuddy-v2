/**
 * PixelSprite —— 字符画精灵 → 内联 SVG（2026-09-28，对话页头像用）。
 *
 * 与 `chat/Mascot.tsx` 同一做法：同一行同色的连续格合并成一个 <rect>，`shape-rendering: crispEdges`，
 * 零位图资源；与落地页序章 / 大陆画布共用 `hero-sprites.ts` 那份字符画与调色板——**勇者在哪儿都是同一个勇者**。
 *
 * ★ 分「定义」与「引用」两半：`<PixelSpriteDefs>` 把点阵注册成一个 `<symbol id>`（整页只放一份），
 *   `<PixelSpriteUse>` 在每个用到的地方只放 `<svg><use/></svg>` 两个节点。勇者 16×17 合并后仍有 104 个 rect，
 *   对话里每条用户消息都要一枚头像——不共用的话 50 轮对话就是五千多个 SVG 节点。
 * ★ 只在整数倍尺寸下用（16 格宽 → 32px / 48px），非整数倍会把格子拉成宽窄不一的条。
 * ★ 纯装饰：`aria-hidden`，不占焦点。颜色直接来自调色板（SVG `fill` 属性，不是内联 style）。
 */
import type { Palette, SpriteMap } from '../app/hero/hero-sprites';
import './pixel-sprite.css';

export type SpriteRun = { x: number; y: number; w: number; fill: string };

/** 字符画 → 横向合并后的色块；未登记调色板的字符与 `.` / 空格一样视为透明 */
export function spriteRuns(map: SpriteMap, pal: Palette): SpriteRun[] {
  const runs: SpriteRun[] = [];
  map.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x] ?? '.';
      const fill = pal[ch];
      if (!fill || ch === '.' || ch === ' ') {
        x += 1;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w] === ch) w += 1;
      runs.push({ x, y, w, fill });
      x += w;
    }
  });
  return runs;
}

/** 一次性定义：把字符画注册成 `<symbol id>`；本身零尺寸、不进无障碍树。同一个 id 整页只放一份 */
export function PixelSpriteDefs({ id, map, pal }: { id: string; map: SpriteMap; pal: Palette }) {
  const w = map.reduce((m, r) => Math.max(m, r.length), 0);
  const h = map.length;
  return (
    <svg className="px-sprite-defs" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <symbol id={id} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges">
        {spriteRuns(map, pal).map((r) => (
          <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
        ))}
      </symbol>
    </svg>
  );
}

/** 引用：两个节点画出一整个精灵。找不到同 id 的 Defs 时什么都不画（不抛、不占位以外的空间） */
export function PixelSpriteUse({ id, className }: { id: string; className?: string }) {
  return (
    <svg className={className} shapeRendering="crispEdges" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
      <use href={`#${id}`} />
    </svg>
  );
}
