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
import { CHIBI_MAP, CHIBI_PAL, SHADE_MAP, SHADE_PAL, TILE_PAL, drawProp, drawSigil, drawTile as drawArtTile, type TilePal } from '../../app/world/continent-art';
import { NPC_ART } from '../../app/world/npc-art';
import type { Domain } from '../../app/world/world-copy';

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
  /** 魔法吟唱（2026-09-28）：咒语的金比收复金更亮更白——同是"赢了"，但这次是用回忆赢的 */
  spell: '#fff1b8',
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

/** 领域 → 地砖风土（关键字优先，其余按字符串散列落到四种之一，同一领域永远同一种地） */
export function domainOf(domain: string): Domain {
  const d = domain.toLowerCase();
  if (/生物|医|生命|bio|life|med/.test(d)) return 'bio';
  if (/化学|chem/.test(d)) return 'chem';
  if (/物理|数学|工程|计算|机器|算法|phy|math|comput|machine|engineer/.test(d)) return 'phy';
  if (/学习|方法|心理|教育|learn|method|psych/.test(d)) return 'learn';
  let h = 0;
  for (const ch of d) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (['bio', 'phy', 'learn', 'chem'] as const)[h % 4]!;
}

function seedOf(row: number, col: number): number {
  return (((row * 73856093) ^ (col * 19349663)) >>> 0) % 1021 + 1;
}

/** 在「格内 16px 逻辑坐标」里作画：进入 → 画 → 复原 */
function inCell(ctx: CanvasRenderingContext2D, row: number, col: number, pop: number, draw: () => void): void {
  const size = 0.7 + 0.3 * pop;
  ctx.save();
  ctx.translate(col * CELL + (CELL * (1 - size)) / 2, row * CELL + (CELL * (1 - size)) / 2);
  ctx.scale(PX * size, PX * size);
  draw();
  ctx.restore();
}

function artTile(ctx: CanvasRenderingContext2D, row: number, col: number, pop: number, pal: TilePal, glow = 0): void {
  inCell(ctx, row, col, pop, () => drawArtTile(ctx, 0, 0, 16, pal, seedOf(row, col), glow));
}

/** 地块：落地页同款带厚度的地砖；越久没碰越暗（时间看得见），逾期 3 天起裂、7 天起裂第二道 */
export function drawTile(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number): void {
  ctx.globalAlpha = pop;
  artTile(ctx, t.row, t.col, pop, TILE_PAL[domainOf(t.domain)]);
  const dim = Math.min(t.overdueDays / 14, 0.6);
  if (dim > 0) {
    ctx.globalAlpha = pop * dim;
    ctx.fillStyle = '#07050a';
    ctx.fillRect(t.col * CELL, t.row * CELL, CELL, CELL);
  }
  ctx.globalAlpha = 1;
  if (t.overdueDays >= 3 && pop > 0.9) {
    const cx = t.col * CELL + CELL / 2;
    const cy = t.row * CELL + CELL / 2 - 6;
    ctx.fillStyle = COLOR.crack;
    for (const [dx, dy] of [[-9, -6], [-6, -3], [-3, 0], [-6, 3], [-9, 6]]) ctx.fillRect(cx + dx!, cy + dy!, 3, 3);
    if (t.overdueDays >= 7) for (const [dx, dy] of [[9, -6], [6, -3], [3, 0]]) ctx.fillRect(cx + dx!, cy + dy!, 3, 3);
  }
}

/**
 * 地上的道具（饥荒式竖立纸片：树 / 石 / 蘑菇 / 草丛）。已复习过的地完整显形，
 * 从没复习过的压暗——「收复进度」靠这个对比（原来的菱形草苗换成了道具，语义不变）。
 */
export function drawSprout(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number): void {
  ctx.globalAlpha = pop * (t.discovered ? 1 : 0.45);
  inCell(ctx, t.row, t.col, pop, () => drawProp(ctx, 3, 12, seedOf(t.row, t.col), domainOf(t.domain), 0));
  if (t.discovered) {
    // 一粒余烬金：这块地你亲手打理过
    ctx.globalAlpha = pop;
    ctx.fillStyle = COLOR.gold;
    ctx.fillRect(t.col * CELL + CELL - 12, t.row * CELL + 6, 3, 3);
  }
  ctx.globalAlpha = 1;
}

/**
 * 领地：紫黑侵蚀地砖 + 血色边界呼吸。
 * ★ `pulse`（0~1）由组件按时间给——**常驻**的缓慢呼吸，不是过渡动画；怪永远画在它上面。
 */
export function drawLand(ctx: CanvasRenderingContext2D, t: CellRef, pop: number, pulse: number): void {
  ctx.globalAlpha = pop;
  artTile(ctx, t.row, t.col, pop, TILE_PAL.corrupt);
  const x = t.col * CELL;
  const y = t.row * CELL;
  ctx.globalAlpha = pop * (0.3 + 0.45 * pulse);
  ctx.fillStyle = COLOR.landLine;
  ctx.fillRect(x + 3, y + 3, CELL - 6, 3);
  ctx.fillRect(x + 3, y + CELL - 12, CELL - 6, 3);
  ctx.fillRect(x + 3, y + 3, 3, CELL - 12);
  ctx.fillRect(x + CELL - 6, y + 3, 3, CELL - 12);
  ctx.globalAlpha = pop * 0.5;
  ctx.fillStyle = '#8a2a6a';
  for (let i = 0; i < 4; i += 1) ctx.fillRect(x + 10 + i * 8, y + CELL - 16 - i * 6, 3, 3);
  ctx.globalAlpha = 1;
}

/** 怪：脚下旋转魔法阵 + 遗忘之影；头顶金色等级角，脚下题型方块 */
export function drawMonster(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number, now = 0): void {
  const x = t.col * CELL;
  const y = t.row * CELL;
  ctx.globalAlpha = pop;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(PX, PX);
  drawSigil(ctx, 8, 9, 7 + Math.min(t.level, 4), now / 1000);
  ctx.restore();
  const s = Math.max(2, Math.round(PX * (0.6 + 0.4 * pop)));
  drawSprite(ctx, SHADE_MAP, SHADE_PAL, Math.round(x + CELL / 2 - 5 * s), Math.round(y + CELL / 2 - 6 * s), { scale: s, flip: true, alpha: pop });
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
 * 学习伙伴（NPC）：落地页招募章同款的游侠立绘（兜帽 + 长弓），缩到 2 倍。
 * ★ 与英雄靠**轮廓**区分（兜帽高挑 + 背弓 vs 红披风矮个），不只靠颜色。
 * ★ `bob` 整数像素起伏；`pulse` 控制遇险红「！」的呼吸（静止时停在当前相位）。
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
  const art = NPC_ART.ranger ?? NPC_ART.mage!;
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

/**
 * 收复特效：扩散环 + 爆散粒子（打怪）与领地回归共用。
 * `spell = true`（魔法吟唱补刀，契约 `docs/SPELL-CHANT-SPEC.md` §3.4）：三圈错相扩散环 + 16 粒火花 + 旋转符文方——
 * 明显比常规一击「更大一号」，但时长不变（仍受 `BURST_MS` ≤1 秒预算约束）。
 */
export function drawBurst(ctx: CanvasRenderingContext2D, t: CellRef, age: number, spell = false): void {
  const p = Math.min(age / BURST_MS, 1);
  const cx = t.col * CELL + CELL / 2;
  const cy = t.row * CELL + CELL / 2;
  const rings = spell ? 3 : 1;
  const sparks = spell ? 16 : 8;
  ctx.strokeStyle = spell ? COLOR.spell : COLOR.gold;
  ctx.lineWidth = 3;
  for (let r = 0; r < rings; r += 1) {
    const q = Math.max(0, Math.min(1, p * (1 + r * 0.35) - r * 0.18));
    ctx.globalAlpha = 1 - q;
    const ring = Math.round(8 + q * (spell ? 40 : 26));
    ctx.strokeRect(cx - ring, cy - ring, ring * 2, ring * 2);
  }
  ctx.globalAlpha = 1 - p;
  ctx.fillStyle = spell ? COLOR.spell : '#ffe9a8';
  for (let i = 0; i < sparks; i += 1) {
    const ang = (Math.PI * 2 * i) / sparks;
    const d = 6 + p * (spell ? 36 : 24);
    ctx.fillRect(Math.round(cx + Math.cos(ang) * d), Math.round(cy + Math.sin(ang) * d), 3, 3);
  }
  if (spell) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4 + p * Math.PI);
    ctx.lineWidth = 2;
    const half = Math.round(6 + p * 18);
    ctx.strokeRect(-half, -half, half * 2, half * 2);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
