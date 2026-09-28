/**
 * features/continent/continent-canvas — 地图的**像素绘制层**（纯 canvas 指令，不含 React）。
 *
 * ★ 为什么从 `ContinentMap.tsx` 拆出来：① `.tsx` 要守 gates 的「≤300 行」红线，十来个 draw
 *   函数塞在组件里当场撞线；② 绘制与交互是两件事——命中换算/悬停/点击分流留在组件，
 *   这里只回答「给定状态怎么画」。将来要换离屏 canvas 或 WebGL，只动这一层。
 * ★ 2026-09-28 画风统一：地砖、道具、小勇者、遗忘之影与魔法阵全部复用落地页第一章的像素美术
 *   （`app/world/continent-art`），逻辑 16px 一格、整体 3 倍放大——正式版与门面是同一片大陆。
 * ★（旧）视觉口径照抄桌面 demo（`studentbuddy-知识大陆-demo.html`）：同一套调色板、同一组像素造型
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
import { drawSprite } from '../../app/hero/hero-sprites';
import { CHIBI_MAP, CHIBI_PAL, SHADE_MAP, SHADE_PAL, drawSigil } from '../../app/world/continent-art';
import { monsterSprite } from './monster-art';
import { NPC_ART } from '../../app/world/npc-art';

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
 * ★ 2026-09-27 起，这两个数只表示"看得见多大"，**不再**表示"世界多大"。
 */
export const CANVAS_W = CONTINENT_VIEW_COLS * CELL;
export const CANVAS_H = CONTINENT_VIEW_ROWS * CELL;

export const COLOR = {
  bg: '#07050a',
  grass: '#2f6b45',
  line: '#23252f',
  gold: '#e8c46a',
  body: '#6b4a7a',
  bodyLine: '#2a1c33',
  horn: '#e0c36b',
  sprout: '#7ee08f',
  crack: 'rgba(7,5,10,0.7)',
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
 * 铺底。★ 它**必须画在相机 `translate` 之外**：世界是以 `(0,0)` 为中心的有符号坐标，
 *   背景若跟着平移，拖到世界负半边就会露出没铺底的缝隙（见 `ContinentMap` 里那句顺序）。
 *   夜色虚空 + 固定星屑（不随时间变，静止帧也好看）。
 */
export function drawBackground(ctx: CanvasRenderingContext2D): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLOR.bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  for (let i = 0; i < 60; i += 1) {
    const h = (i * 2654435761) >>> 0;
    ctx.fillStyle = i % 5 === 0 ? '#3a2a36' : '#1c141b';
    ctx.fillRect(h % CANVAS_W, (h >>> 12) % CANVAS_H, 2, 2);
  }
}

/** 只要求坐标的最小形状（荒地格没有词条也要能画成领地） */
export interface CellRef {
  row: number;
  col: number;
}

/** 像素倍率：落地页美术按 16px 一格绘制，这里放大到 CELL */
const PX = CELL / 16;

/**
 * 怪：脚下魔法阵 + **按怪种生成的外观**（`monster-art.ts`：一种题型组合一种样子），
 * 头顶血量格（每格＝一道题），脚下题型方块。野怪多一圈迷雾色光晕；遗忘之影脚下是血红魔法阵。
 * `pop`（0~1）＝刷出时的淡入与落地。
 */
export function drawMonster(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number, now = 0): void {
  const x = t.col * CELL;
  const y = t.row * CELL;
  ctx.globalAlpha = pop;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(PX, PX);
  drawSigil(ctx, 8, 10, 6 + Math.min(t.level, 3), now / 1000);
  ctx.restore();
  const art = t.wild ? monsterSprite(t.species) : { map: SHADE_MAP, pal: SHADE_PAL };
  const s = t.wild ? (t.level >= 3 ? 4 : 3) : Math.max(2, Math.round(PX * (0.6 + 0.4 * pop)));
  const w = (art.map[0]?.length ?? 12) * s;
  const hh = art.map.length * s;
  const bob = Math.round(Math.sin(now / 400 + t.row + t.col) * 1.5);
  const drop = Math.round((1 - pop) * -18);
  drawSprite(ctx, art.map, art.pal, Math.round(x + CELL / 2 - w / 2), Math.round(y + CELL - hh - 4 + bob + drop), { scale: s, flip: true, alpha: pop });
  ctx.globalAlpha = pop;
  const pips = Math.min(t.hp, 9);
  for (let i = 0; i < pips; i += 1) {
    const hx = Math.round(x + CELL / 2 + (i - (pips - 1) / 2) * 5);
    ctx.fillStyle = '#07050a';
    ctx.fillRect(hx - 2, y - 4, 5, 5);
    ctx.fillStyle = t.wild ? '#ff5f5f' : COLOR.horn;
    ctx.fillRect(hx - 1, y - 3, 3, 3);
  }
  t.species.forEach((species: ContinentQType, i: number) => {
    ctx.fillStyle = COLOR.bodyLine;
    ctx.fillRect(Math.round(x + CELL / 2 + (i - (t.species.length - 1) / 2) * 7) - 3, y + CELL - 7, 6, 6);
    ctx.fillStyle = CONTINENT_QCOLOR[species];
    ctx.fillRect(Math.round(x + CELL / 2 + (i - (t.species.length - 1) / 2) * 7) - 2, y + CELL - 6, 4, 4);
  });
  ctx.globalAlpha = 1;
}

/**
 * 宝箱（打怪掉落物）：上下浮动的铁箍木箱。
 * ★ 掉落的**只有位置没有账**——开箱走既有每日宝箱账本（`shared/continent.ts` 头注「宝箱」段）。
 */
export function drawChest(ctx: CanvasRenderingContext2D, row: number, col: number, bob: number): void {
  const x = Math.round(col * CELL + CELL / 2);
  const y = Math.round(row * CELL + CELL / 2 + bob);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - 11, y + 12 - bob, 22, 3);
  ctx.fillStyle = '#07050a';
  ctx.fillRect(x - 11, y - 11, 22, 23);
  ctx.fillStyle = COLOR.chestDark;
  ctx.fillRect(x - 9, y - 1, 18, 11);
  ctx.fillStyle = COLOR.chest;
  ctx.fillRect(x - 9, y - 9, 18, 7);
  ctx.fillStyle = '#5a5566';
  ctx.fillRect(x - 9, y - 2, 18, 2);
  ctx.fillRect(x - 6, y - 9, 2, 19);
  ctx.fillRect(x + 4, y - 9, 2, 19);
  ctx.fillStyle = COLOR.gold;
  ctx.fillRect(x - 2, y - 3, 4, 6);
}

/**
 * 英雄：落地页同款红披风小勇者。`from` + `k`（0~1）做格子间的插值——走位要像在"走"。
 * `k = 1` 即静止（`prefers-reduced-motion` 由组件直接传 1）。朝左时水平翻转。
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
  const step = k < 1 && Math.floor(k * 4) % 2 === 1 ? PX : 0;
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(cx - 12, cy + 12, 24, 4);
  drawSprite(ctx, CHIBI_MAP, CHIBI_PAL, cx - 4 * PX, cy - 6 * PX - step, { scale: PX, flip: hero.face === 'left' });
  // 朝向标：一粒金色余烬，让"我面朝哪"在像素体上也读得出来
  ctx.fillStyle = COLOR.gold;
  if (hero.face === 'up') ctx.fillRect(cx - 2, cy - 24, 4, 3);
  else if (hero.face === 'down') ctx.fillRect(cx - 2, cy + 17, 4, 3);
  else if (hero.face === 'left') ctx.fillRect(cx - 18, cy - 4, 3, 4);
  else ctx.fillRect(cx + 15, cy - 4, 3, 4);
}

/**
 * 学习伙伴（NPC）：落地页招募章同款的职业立绘（法师 / 骑士 / 游侠 / 吟游诗人），缩到 2 倍。
 * ★ 与英雄靠**轮廓**区分（兜帽高挑 + 背弓 vs 红披风矮个），不只靠颜色。
 * ★ `bob` 整数像素起伏；`pulse` 控制遇险红「！」的呼吸（静止时停在当前相位）。
 */
export function drawNpc(
  ctx: CanvasRenderingContext2D,
  spot: CellRef,
  bob: number,
  distressed: boolean,
  pulse = 0.5,
  job = 'ranger',
): void {
  const cx = Math.round(spot.col * CELL + CELL / 2);
  const cy = Math.round(spot.row * CELL + CELL / 2 + bob);
  const art = NPC_ART[job] ?? NPC_ART.ranger!;
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(cx - 10, cy + 13 - bob, 20, 3);
  drawSprite(ctx, art.map, art.pal, cx - 12, cy - 16, { scale: 2 });
  if (distressed) {
    ctx.globalAlpha = 0.55 + 0.45 * Math.max(Math.min(pulse, 1), 0);
    ctx.fillStyle = '#07050a';
    ctx.fillRect(cx - 3, cy - 32, 7, 14);
    ctx.fillStyle = COLOR.npcAlert;
    ctx.fillRect(cx - 1, cy - 30, 3, 6);
    ctx.fillRect(cx - 1, cy - 22, 3, 3);
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
const EMBER_HUE: Record<string, [string, string]> = {
  cyan: ['#7ff0ff', '#1aa3c2'],
  violet: ['#d6a8ff', '#7a3cc9'],
  gold: ['#ffe08a', '#c98a1a'],
  green: ['#a8ffb0', '#2f9e48'],
};

/** 余烬笺的异色篝火：光晕 + 柴堆 + 两帧跳动的火苗 + 飘起的火星（静止帧也读得出是火） */
export function drawEmber(ctx: CanvasRenderingContext2D, spot: CellRef & { hue: string }, now: number): void {
  const [h1, h2] = EMBER_HUE[spot.hue] ?? EMBER_HUE.cyan!;
  const x = spot.col * CELL;
  const y = spot.row * CELL;
  const f = Math.floor(now / 140) % 2;
  ctx.globalAlpha = 0.28 + 0.08 * f;
  ctx.fillStyle = h2;
  ctx.fillRect(x - 6, y - 6, CELL + 12, CELL + 12);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#3b2616';
  ctx.fillRect(x + 12, y + 34, 24, 4);
  ctx.fillRect(x + 15, y + 30, 18, 4);
  ctx.fillStyle = '#07050a';
  ctx.fillRect(x + 14, y + 8 - f * 2, 20, 24 + f * 2);
  ctx.fillStyle = h2;
  ctx.fillRect(x + 16, y + 10 - f * 2, 16, 22 + f * 2);
  ctx.fillStyle = h1;
  ctx.fillRect(x + 19 + f * 2, y + 15 - f, 8, 16);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + 22, y + 24, 4, 5);
  ctx.fillStyle = h1;
  const rise = Math.floor(now / 200) % 4;
  ctx.fillRect(x + 12 + f * 18, y + 2 - rise * 2, 2, 2);
  ctx.fillRect(x + 30 - f * 10, y - 4 - rise, 2, 2);
}
