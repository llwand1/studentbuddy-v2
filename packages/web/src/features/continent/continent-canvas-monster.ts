/**
 * features/continent/continent-canvas-monster — 地图上的**怪与开拓入口**的像素绘制（从 `continent-canvas.ts` 拆出）。
 *
 * ★ 为什么拆：`continent-canvas.ts` 加上怪种外观与「+」之后越过 gates 的「web .ts ≤400 行」红线。
 *   接缝取在"活物 vs 地形"：这里是怪（外观按怪种，`monster-art.ts`）与边界上的「+」（开拓入口），
 *   那边仍是地砖 / 领地 / 英雄 / 伙伴 / 宝箱 / 特效。共用的尺寸与色板（`CELL` / `PX` / `COLOR`）从那边引，
 *   **不反向 import**（`ContinentMap.tsx` 各引各的，不成环）。
 * ★ 野怪与欠账怪**同一张脸**（怪种由题型序列定，图鉴才对得上），来路的区别只在脚下魔法阵的颜色
 *   与是否浮动：欠账怪是"钉在这块地上"的，野怪是"游荡到这儿"的。
 */
import { CONTINENT_QCOLOR, type ContinentQType } from '@sb/shared';
import type { ContinentTileView } from './continent-view';
import { drawSprite } from '../../app/hero/hero-sprites';
import { drawSigil, type SigilColors } from '../../app/world/continent-art';
import { CELL, COLOR, PX } from './continent-canvas';
import { monsterLook } from './monster-art';

/** 野怪脚下的魔法阵：青绿（与欠账怪的血色拉开——同一张脸，来路靠脚下的阵认） */
const SIGIL_WILD: SigilColors = ['#7ee08f', '#2a6a4a'];
/** 话题怪脚下的魔法阵（2026-09-30）：金——"你刚聊到的"，与血色 / 青绿都拉开 */
const SIGIL_TOPIC: SigilColors = ['#ffd84a', '#8a6a1a'];
const SIGIL_BY_KIND: Partial<Record<NonNullable<ContinentTileView['monsterKind']>, SigilColors>> = { wild: SIGIL_WILD, topic: SIGIL_TOPIC };

/**
 * 怪：脚下旋转魔法阵 + **按怪种定的外观**（`monster-art.ts`：体型/配色/饰物由题型序列决定）；
 * 头顶金色等级角，脚下题型方块。野怪与欠账怪同脸不同阵（`monsterKind`）。
 */
export function drawMonster(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number, now = 0): void {
  const x = t.col * CELL;
  const y = t.row * CELL;
  ctx.globalAlpha = pop;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(PX, PX);
  drawSigil(ctx, 8, 9, 7 + Math.min(t.level, 4), now / 1000, t.monsterKind ? SIGIL_BY_KIND[t.monsterKind] : undefined);
  ctx.restore();
  const s = Math.max(2, Math.round(PX * (0.6 + 0.4 * pop)));
  const look = monsterLook(t.species);
  // 12×12 的怪居中偏下（脚踩在魔法阵上）；野怪 / 话题怪微微上下浮动，欠账怪站定（它是"钉在这块地上"的）
  const bob = t.monsterKind === 'wild' || t.monsterKind === 'topic' ? Math.round(Math.sin(now / 300 + t.col) * 1.5) : 0;
  drawSprite(ctx, look.map, look.pal, Math.round(x + CELL / 2 - 6 * s), Math.round(y + CELL / 2 - 7 * s + bob), { scale: s, alpha: pop });
  ctx.globalAlpha = pop;
  ctx.fillStyle = COLOR.horn;
  for (let i = 0; i < t.level; i += 1) {
    const hx = Math.round(x + CELL / 2 + (i - (t.level - 1) / 2) * 7);
    ctx.fillRect(hx - 2, y + 1, 4, 4);
  }
  t.species.forEach((species: ContinentQType, i: number) => {
    ctx.fillStyle = COLOR.bodyLine;
    ctx.fillRect(Math.round(x + CELL / 2 + (i - (t.species.length - 1) / 2) * 7) - 3, y + CELL - 9, 6, 6);
    ctx.fillStyle = CONTINENT_QCOLOR[species];
    ctx.fillRect(Math.round(x + CELL / 2 + (i - (t.species.length - 1) / 2) * 7) - 2, y + CELL - 8, 4, 4);
  });
  ctx.globalAlpha = 1;
}

/**
 * 边界空地上的「+」（开拓入口）：虚线小框 + 十字，随 `pulse` 呼吸。
 * ★ 画得比地块**轻**（细线、半透明）：它是"这里可以长出来"的邀请，不是地块；
 *   与选位态的绿框（`drawFrame`）同色系但形状不同（十字 vs 满框），两种"绿"不会混。
 */
export function drawFrontier(ctx: CanvasRenderingContext2D, cell: { row: number; col: number }, pulse: number): void {
  const x = cell.col * CELL;
  const y = cell.row * CELL;
  const cx = x + CELL / 2;
  const cy = y + CELL / 2;
  ctx.globalAlpha = 0.35 + 0.4 * pulse;
  ctx.fillStyle = COLOR.sprout;
  // 四角短线（虚线框的像素版）
  for (const [sx, sy] of [
    [x + 6, y + 6],
    [x + CELL - 12, y + 6],
    [x + 6, y + CELL - 12],
    [x + CELL - 12, y + CELL - 12],
  ] as const) {
    ctx.fillRect(sx, sy, 6, 2);
    ctx.fillRect(sx, sy, 2, 6);
  }
  // 十字
  ctx.fillStyle = COLOR.bodyLine;
  ctx.fillRect(cx - 7, cy - 2, 14, 4);
  ctx.fillRect(cx - 2, cy - 7, 4, 14);
  ctx.fillStyle = COLOR.sprout;
  ctx.fillRect(cx - 6, cy - 1, 12, 2);
  ctx.fillRect(cx - 1, cy - 6, 2, 12);
  ctx.globalAlpha = 1;
}
