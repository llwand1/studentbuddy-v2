/**
 * features/continent/continent-canvas — 地图的**像素绘制层**（纯 canvas 指令，不含 React）。
 *
 * ★ 为什么从 `ContinentMap.tsx` 拆出来：① `.tsx` 要守 gates 的「≤300 行」红线，十来个 draw
 *   函数塞在组件里当场撞线；② 绘制与交互是两件事——命中换算/悬停/点击分流留在组件，
 *   这里只回答「给定状态怎么画」。将来要换离屏 canvas 或 WebGL，只动这一层。
 * ★ 视觉口径照抄桌面 demo（`studentbuddy-知识大陆-demo.html`）：同一套调色板、同一组像素造型
 *   ——阶梯轮廓的怪、菱形草苗、上下浮动的宝箱、四朝向的小人。**不做浅色化**（`docs/PIXEL-UI.md`：
 *   像素风是最高画风优先级，深色大陆面板是它的载体）。
 * ★ 特效预算：单次过渡 ≤1 秒（`BURST_MS`）；只画不动 DOM；领地边界的"呼吸"是常驻的
 *   静止演出（不是过渡动画），故不受 1 秒预算约束。
 *   `prefers-reduced-motion` 由组件层处理（传 `k = 1` / `pulse = 0.5` / `bob = 0`），
 *   本层不做媒体查询——同一份指令在两种模式下都可执行。
 */
import { CONTINENT_VIEW_COLS, CONTINENT_QCOLOR, CONTINENT_VIEW_ROWS, type ContinentQType } from '@sb/shared';
import type { ContinentTileView } from './continent-view';
import type { HeroCell } from './useContinentHero';

/** 格子边长（逻辑像素；CSS 再缩放，故命中判定必须走比例换算而不是写死这个数） */
export const CELL = 48;
/** 地块「长出来」的动画时长与错峰步长 */
export const POP_MS = 320;
export const STAGGER_MS = 9;
export const STAGGER_CAP = 60;
/** 击杀/收复特效时长（压在 1 秒内：地图是常驻页，动画长了会挡住下一次点击） */
export const BURST_MS = 560;
/**
 * 画布像素尺寸 ＝ **视口**大小（世界比它大；相机由 `ContinentMap`／`useContinentCamera` 管）。
 * ★ 2026-09-27 开放世界批起，这两个数只表示"看得见多大"，**不再**表示"世界多大"。
 */
export const CANVAS_W = CONTINENT_VIEW_COLS * CELL;
export const CANVAS_H = CONTINENT_VIEW_ROWS * CELL;

export const COLOR = {
  bg: '#0a0a0f',
  grass: '#2f6b45',
  line: '#23252f',
  gold: '#f2c14e',
  body: '#6b4a7a',
  bodyLine: '#2a1c33',
  horn: '#e0c36b',
  sprout: '#7ee08f',
  crack: 'rgba(6,10,8,0.55)',
  /** 被占领的地与被"血色"边界：与草地/怪都拉开，一眼看出"这不是你的地" */
  land: '#3a1622',
  landLine: '#c2455f',
  hero: '#e8e9ee',
  heroDark: '#3b4266',
  chest: '#c98a33',
  chestDark: '#6b4318',
  hover: '#e8e9ee',
  /** 学习伙伴（2026-09-27）：蓝衣橙帽——与英雄（白/深蓝）、怪（紫）都拉开，一眼认得出"那是人" */
  npcBody: '#3f6d8f',
  npcFace: '#e8d5c0',
  npcHat: '#d98a4a',
  /** 遇险时头顶的红惊叹块。★ 与领地红（landLine）刻意不同色：一个是"地丢了"，一个是"人在喊" */
  npcAlert: '#ff5f5f',
};

/**
 * 铺底。★ 开放世界批起它**必须画在相机 `translate` 之外**：世界是以 `(0,0)` 为中心的有符号坐标，
 *   背景若跟着平移，拖到世界负半边就会露出没铺底的缝隙（见 `ContinentMap` 里那句顺序）。
 */
export function drawBackground(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

/**
 * 只要求坐标的最小形状：领地、悬停框、特效都只需要"哪一格"，不需要"这格里是什么词条"。
 * ★ 用结构类型而不是 `ContinentTileView`：荒地格（没有词条）也要能被画成领地，
 *   否则调用方得伪造一个 tile 出来（伪造出来的字段迟早会被某处当真）。
 */
export interface CellRef {
  row: number;
  col: number;
}

/** 地块：越久没碰越暗（时间看得见），逾期 3 天起裂、7 天起裂第二道 */
export function drawTile(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number): void {
  const x = t.col * CELL;
  const y = t.row * CELL;
  const size = CELL * (0.7 + 0.3 * pop);
  const off = (CELL - size) / 2;
  ctx.globalAlpha = pop * (1 - Math.min(t.overdueDays / 14, 0.68));
  ctx.fillStyle = COLOR.grass;
  ctx.fillRect(x + off, y + off, size, size);
  ctx.globalAlpha = pop * 0.65;
  ctx.strokeStyle = COLOR.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + off + 1, y + off + 1, size - 2, size - 2);
  ctx.globalAlpha = 1;
  if (t.overdueDays >= 3 && pop > 0.9) {
    ctx.strokeStyle = COLOR.crack;
    ctx.lineWidth = 1.5;
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy - 8);
    ctx.lineTo(cx - 2, cy + 1);
    ctx.lineTo(cx - 7, cy + 9);
    ctx.stroke();
    if (t.overdueDays >= 7) {
      ctx.beginPath();
      ctx.moveTo(cx + 9, cy - 9);
      ctx.lineTo(cx + 3, cy + 2);
      ctx.stroke();
    }
  }
}

/** 已收复的草苗（菱形）；没复习过的压暗——「收复进度」靠这个对比 */
export function drawSprout(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number): void {
  const cx = t.col * CELL + CELL / 2;
  const cy = t.row * CELL + CELL / 2;
  ctx.globalAlpha = pop * (t.discovered ? 1 : 0.42);
  ctx.fillStyle = t.discovered ? COLOR.sprout : '#6a7a72';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx + 4, cy);
  ctx.lineTo(cx, cy + 5);
  ctx.lineTo(cx - 4, cy);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * 领地：压暗的地 + 血色斜纹 + 边界呼吸。
 * ★ `pulse`（0~1）由组件按时间给——它是**常驻**的缓慢呼吸，不是过渡动画，
 *   作用是让占领区在静止状态下也"活着"，并且不抢怪的视线（怪永远画在它上面）。
 */
export function drawLand(ctx: CanvasRenderingContext2D, t: CellRef, pop: number, pulse: number): void {
  const x = t.col * CELL;
  const y = t.row * CELL;
  ctx.globalAlpha = pop * 0.94;
  ctx.fillStyle = COLOR.land;
  ctx.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
  ctx.globalAlpha = pop * (0.3 + 0.4 * pulse);
  ctx.strokeStyle = COLOR.landLine;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 3, y + 3, CELL - 6, CELL - 6);
  ctx.globalAlpha = pop * 0.22;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 7, y + CELL - 7);
  ctx.lineTo(x + CELL - 7, y + 7);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** 像素怪：阶梯轮廓、等级角与题型方块，共用整数像素网格 */
export function drawMonster(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number): void {
  const cx = t.col * CELL + CELL / 2;
  const cy = t.row * CELL + CELL / 2;
  const r = Math.max(2, Math.round((9 + t.level * 4) * pop / 2) * 2);
  ctx.globalAlpha = pop;
  ctx.fillStyle = COLOR.bodyLine;
  ctx.fillRect(cx - r, cy - r + 4, r * 2, r * 2 - 4);
  ctx.fillRect(cx - r + 4, cy - r, r * 2 - 8, r * 2 + 4);
  ctx.fillStyle = COLOR.body;
  ctx.fillRect(cx - r + 2, cy - r + 6, r * 2 - 4, r * 2 - 8);
  ctx.fillRect(cx - r + 6, cy - r + 2, r * 2 - 12, r * 2 - 2);
  ctx.fillStyle = COLOR.horn;
  for (let i = 0; i < t.level; i += 1) {
    const hx = Math.round(cx + (i - (t.level - 1) / 2) * 8);
    ctx.fillRect(hx - 2, cy - r - 4, 4, 8);
    ctx.fillRect(hx, cy - r - 8, 2, 4);
  }
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(cx - 8, cy - 4, 4, 4);
  ctx.fillRect(cx + 4, cy - 4, 4, 4);
  t.species.forEach((species: ContinentQType, i: number) => {
    ctx.fillStyle = CONTINENT_QCOLOR[species];
    ctx.fillRect(cx + (i - (t.species.length - 1) / 2) * 6 - 2, cy + 6, 4, 4);
  });
  ctx.globalAlpha = 1;
}

/**
 * 宝箱（打怪掉落物）：上下浮动的像素箱。
 * ★ 掉落的**只有位置没有账**——开箱走既有每日宝箱账本（`shared/continent.ts` 头注「宝箱」段）。
 *   所以这里画的是一个"入口"，不是一个可囤的资产。
 */
export function drawChest(ctx: CanvasRenderingContext2D, row: number, col: number, bob: number): void {
  const x = Math.round(col * CELL + CELL / 2);
  const y = Math.round(row * CELL + CELL / 2 + bob);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x - 9, y + 12 - bob, 18, 3);
  ctx.fillStyle = COLOR.chestDark;
  ctx.fillRect(x - 9, y - 2, 18, 13);
  ctx.fillStyle = COLOR.chest;
  ctx.fillRect(x - 9, y - 8, 18, 7);
  ctx.fillStyle = COLOR.chestDark;
  ctx.fillRect(x - 10, y - 10, 20, 3);
  ctx.fillStyle = COLOR.gold;
  ctx.fillRect(x - 2, y - 2, 4, 8);
}

/**
 * 英雄（四朝向小人）。`from` + `k`（0~1）做格子间的插值——走位要看起来在"走"而不是闪现。
 * `k = 1` 即静止（`prefers-reduced-motion` 由组件直接传 1）。
 */
export function drawHero(
  ctx: CanvasRenderingContext2D,
  hero: HeroCell,
  from: { row: number; col: number } | null,
  k: number,
): void {
  const gx = from ? from.col + (hero.col - from.col) * k : hero.col;
  const gy = from ? from.row + (hero.row - from.row) * k : hero.row;
  const cx = Math.round(gx * CELL + CELL / 2);
  const cy = Math.round(gy * CELL + CELL / 2);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fillRect(cx - 8, cy + 12, 16, 3);
  ctx.fillStyle = COLOR.heroDark;
  ctx.fillRect(cx - 7, cy - 3, 14, 14);
  ctx.fillStyle = COLOR.hero;
  ctx.fillRect(cx - 6, cy - 14, 12, 11);
  if (hero.face !== 'up') {
    ctx.fillStyle = COLOR.bg;
    ctx.fillRect(cx - 4, cy - 10, 3, 3);
    ctx.fillRect(cx + 1, cy - 10, 3, 3);
  }
  // 朝向标：一块金色小角，让"我面朝哪"在像素体上也读得出来
  ctx.fillStyle = COLOR.gold;
  if (hero.face === 'up') ctx.fillRect(cx - 2, cy - 17, 4, 3);
  else if (hero.face === 'down') ctx.fillRect(cx - 2, cy + 11, 4, 3);
  else if (hero.face === 'left') ctx.fillRect(cx - 10, cy - 9, 3, 4);
  else ctx.fillRect(cx + 7, cy - 9, 3, 4);
}

/**
 * 学习伙伴（NPC）——**像素小人**：比英雄矮一头、戴一顶橙帽，一眼分得清"哪个是我"。
 *
 * ★ 与英雄的区别做在两处而不是配色一处：**高度**（少 4px）与**帽檐**（英雄没有帽）。
 *   像素风里颜色是最不可靠的区分手段（色弱、小屏、压暗的领地格都会吃掉它）。
 * ★ `bob`：待机时轻轻起伏的整数像素（照宝箱那条口径：整数像素，不然像素格会糊）。
 * ★ `pulse`（0~1）：遇险时红惊叹块的呼吸强弱。★ 它**不是独立动画循环**——地图静止时
 *   停在当前相位（与领地边界的"常驻呼吸"同一取舍：地图是常驻页，空转 rAF 等于持续耗电）。
 * `prefers-reduced-motion` 由组件传固定 `bob=0` / `pulse=1`（常亮），本层不做媒体查询。
 */
export function drawNpc(
  ctx: CanvasRenderingContext2D,
  spot: CellRef,
  bob: number,
  distressed: boolean,
  pulse = 0.5,
): void {
  const cx = Math.round(spot.col * CELL + CELL / 2);
  const cy = Math.round(spot.row * CELL + CELL / 2 + bob);
  ctx.globalAlpha = 1;
  // 影子 → 身子 → 头 → 帽（自下而上，后画的盖住先画的）
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(cx - 7, cy + 10, 14, 3);
  ctx.fillStyle = COLOR.npcBody;
  ctx.fillRect(cx - 5, cy - 1, 10, 11);
  ctx.fillStyle = COLOR.npcFace;
  ctx.fillRect(cx - 5, cy - 12, 10, 11);
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(cx - 3, cy - 8, 2, 2);
  ctx.fillRect(cx + 1, cy - 8, 2, 2);
  ctx.fillStyle = COLOR.npcHat;
  ctx.fillRect(cx - 8, cy - 15, 16, 4); // 帽檐
  ctx.fillRect(cx - 4, cy - 18, 8, 3); // 帽顶
  if (distressed) {
    // 只动 opacity（契约 §7.2）：一个竖条 + 一个点 = 喊得出的那个「！」
    ctx.globalAlpha = 0.55 + 0.45 * Math.max(Math.min(pulse, 1), 0);
    ctx.fillStyle = COLOR.npcAlert;
    ctx.fillRect(cx - 1, cy - 28, 3, 6);
    ctx.fillRect(cx - 1, cy - 20, 3, 3);
    ctx.globalAlpha = 1;
  }
}

/** 高亮框（悬停 / 弹窗锁定的那一格） */
export function drawFrame(ctx: CanvasRenderingContext2D, t: CellRef, color: string, pop: number): void {
  ctx.globalAlpha = Math.max(pop, 0.9);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(t.col * CELL + 2, t.row * CELL + 2, CELL - 4, CELL - 4);
  ctx.globalAlpha = 1;
}

/** 收复特效：扩散环 + 爆散粒子（打怪）与领地回归共用 */
export function drawBurst(ctx: CanvasRenderingContext2D, t: CellRef, age: number, color = COLOR.gold): void {
  const p = Math.min(age / BURST_MS, 1);
  const cx = t.col * CELL + CELL / 2;
  const cy = t.row * CELL + CELL / 2;
  ctx.globalAlpha = 1 - p;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  const ring = Math.round(8 + p * 26);
  ctx.strokeRect(cx - ring, cy - ring, ring * 2, ring * 2);
  ctx.fillStyle = '#ffe9a8';
  for (let i = 0; i < 8; i += 1) {
    const ang = (Math.PI * 2 * i) / 8;
    const d = 6 + p * 24;
    ctx.fillRect(Math.round(cx + Math.cos(ang) * d), Math.round(cy + Math.sin(ang) * d), 3, 3);
  }
  ctx.globalAlpha = 1;
}