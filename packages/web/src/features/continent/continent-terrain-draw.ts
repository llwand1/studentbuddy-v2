/**
 * features/continent/continent-terrain-draw — 地貌、地貌过渡、迷雾、地块等级的像素绘制。
 *
 * ★ 过渡：相邻两格地貌不同 ⇒ 在交界两侧各画两排**抖动像素**（棋盘格密度 1/2 → 1/4）互相渗透，
 *   水陆交界再加一道会动的浪花。于是草原进森林、沙岸入海都是「渐变」，不是硬切的色块。
 * ★ 迷雾：离已开拓地 1~vision 格的地貌半透明可见（越远越暗），再远全黑；迷雾边缘同样用抖动像素收边。
 * ★ 全部是纯 canvas 指令，时间由调用方传入（`now`），`prefers-reduced-motion` 时传 0 即静止帧。
 */
import { terrainAt, type Biome } from '@sb/shared';
import { drawProp } from '../../app/world/continent-art';
import type { Domain } from '../../app/world/world-copy';

export const T = 48;
const P = 3; // 一个「像素点」的屏幕尺寸（16 逻辑像素 × 3 = 48）

type Ctx = CanvasRenderingContext2D;

export const BIOME_PAL: Record<Biome, { base: string; lite: string; dark: string }> = {
  deep: { base: '#16304f', lite: '#24507a', dark: '#0d1d33' },
  shallow: { base: '#2a5f7f', lite: '#4c8fae', dark: '#1d445c' },
  sand: { base: '#b89a5e', lite: '#d8bd80', dark: '#8a7142' },
  grass: { base: '#3f6b36', lite: '#5f8f4a', dark: '#2c4d26' },
  meadow: { base: '#58763c', lite: '#7d9a52', dark: '#3d5629' },
  forest: { base: '#2a4a2c', lite: '#3f6a3c', dark: '#1a311c' },
  swamp: { base: '#3a4a37', lite: '#55664a', dark: '#262f24' },
  desert: { base: '#a8804a', lite: '#c9a066', dark: '#7a5a30' },
  hill: { base: '#5f6448', lite: '#80866a', dark: '#44482f' },
  snow: { base: '#c8d2dc', lite: '#eef3f8', dark: '#95a2b0' },
  mountain: { base: '#55535f', lite: '#7c7a88', dark: '#35343d' },
};

const PROP_DOMAIN: Partial<Record<Biome, Domain>> = { forest: 'bio', hill: 'phy', mountain: 'phy', desert: 'learn', swamp: 'chem' };

function h(row: number, col: number, salt: number): number {
  let x = (row * 73856093) ^ (col * 19349663) ^ (salt * 83492791);
  x = Math.imul(x ^ (x >>> 13), 0x5bd1e995);
  return (x ^ (x >>> 15)) >>> 0;
}

const isWater = (b: Biome): boolean => b === 'deep' || b === 'shallow';

/** 一格地貌（底色 + 纹理 + 地貌小景）。`x,y` 为屏幕左上角 */
export function drawBiome(ctx: Ctx, seed: number, row: number, col: number, now: number): void {
  const { biome, elev } = terrainAt(seed, row, col);
  const pal = BIOME_PAL[biome];
  const x = col * T;
  const y = row * T;
  ctx.fillStyle = pal.base;
  ctx.fillRect(x, y, T, T);
  // 纹理点：每格固定 7 粒亮点 + 5 粒暗点
  for (let i = 0; i < 12; i += 1) {
    const r = h(row, col, i);
    ctx.fillStyle = i < 7 ? pal.lite : pal.dark;
    ctx.fillRect(x + (r % 16) * P, y + ((r >>> 8) % 16) * P, P, P);
  }
  const r0 = h(row, col, 99);
  if (isWater(biome)) {
    const ph = Math.floor(now / 420 + (r0 % 7)) % 4;
    ctx.fillStyle = pal.lite;
    ctx.fillRect(x + ((r0 % 8) + ph) * P, y + (4 + (r0 % 3)) * P, 3 * P, P);
    ctx.fillRect(x + ((r0 >>> 5) % 8 + 4 - ph) * P, y + (11 + ((r0 >>> 9) % 3)) * P, 2 * P, P);
    return;
  }
  // 高差：海拔越高，下沿阴影越重（地形读得出起伏）
  ctx.globalAlpha = Math.min(Math.max((elev - 0.45) * 1.4, 0), 0.35);
  ctx.fillStyle = '#07050a';
  ctx.fillRect(x, y + T - P * 2, T, P * 2);
  ctx.globalAlpha = 1;
  const k = r0 % 10;
  if (biome === 'grass' && k < 4) tuft(ctx, x + (r0 % 10 + 2) * P, y + ((r0 >>> 6) % 8 + 5) * P, '#7fae5c');
  else if (biome === 'meadow' && k < 6) {
    for (let i = 0; i < 3; i += 1) {
      const q = h(row, col, 40 + i);
      ctx.fillStyle = ['#e8c46a', '#d98cff', '#f4efe6'][i]!;
      ctx.fillRect(x + (q % 14 + 1) * P, y + ((q >>> 7) % 12 + 2) * P, P, P);
    }
  } else if (biome === 'snow' && k < 5) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + (r0 % 12 + 2) * P, y + ((r0 >>> 5) % 10 + 3) * P, P, P);
  } else if (biome === 'mountain') {
    peak(ctx, x, y, r0);
  } else if (biome === 'sand' && k < 3) {
    ctx.fillStyle = '#e8d6a8';
    ctx.fillRect(x + (r0 % 12 + 2) * P, y + 12 * P, 2 * P, P);
  }
  const dom = PROP_DOMAIN[biome];
  if (dom && biome !== 'mountain' && k < (biome === 'forest' ? 8 : 3)) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(P, P);
    drawProp(ctx, 3, 12, (r0 % 1000) + 1, dom, 0);
    ctx.restore();
  }
}

function tuft(ctx: Ctx, x: number, y: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(x, y, P, P * 2);
  ctx.fillRect(x + P * 2, y - P, P, P * 3);
  ctx.fillRect(x + P * 4, y, P, P * 2);
}

function peak(ctx: Ctx, x: number, y: number, r: number): void {
  const off = (r % 4) * P;
  const rows = [[7, 2], [6, 4], [5, 6], [4, 8], [3, 10], [2, 12]];
  rows.forEach(([sx, w], i) => {
    ctx.fillStyle = i < 2 ? '#eef3f8' : i % 2 ? '#3f3e48' : '#4a4955';
    ctx.fillRect(x + sx! * P + off - P, y + (3 + i * 2) * P, w! * P, P * 2);
  });
}

/**
 * 地貌过渡：在本格靠近「异地貌邻居」的两排像素里撒邻居的颜色（抖动渐变），水陆交界加浪花。
 * 两侧格子都会各自画一次 ⇒ 交界处是对称的软边。
 */
export function drawBiomeBlend(ctx: Ctx, seed: number, row: number, col: number, now: number): void {
  const me = terrainAt(seed, row, col).biome;
  const x = col * T;
  const y = row * T;
  const dirs: Array<[number, number, 'n' | 's' | 'w' | 'e']> = [[-1, 0, 'n'], [1, 0, 's'], [0, -1, 'w'], [0, 1, 'e']];
  for (const [dr, dc, side] of dirs) {
    const other = terrainAt(seed, row + dr, col + dc).biome;
    if (other === me) continue;
    const pal = BIOME_PAL[other];
    for (let band = 0; band < 2; band += 1) {
      for (let i = 0; i < 16; i += 1) {
        if (band === 0 ? (i + row + col) % 2 !== 0 : (i + row + col) % 4 !== 1) continue;
        ctx.fillStyle = band === 0 ? pal.base : pal.lite;
        const [px, py] =
          side === 'n' ? [i, band] : side === 's' ? [i, 15 - band] : side === 'w' ? [band, i] : [15 - band, i];
        ctx.fillRect(x + px * P, y + py * P, P, P);
      }
    }
    if (isWater(me) && !isWater(other)) {
      // 浪花：沿岸一条随时间明灭的白线
      const on = Math.floor(now / 500 + row * 3 + col) % 3 !== 0;
      if (!on) continue;
      ctx.fillStyle = '#cfe8f0';
      for (let i = 1; i < 15; i += 3) {
        const [px, py] = side === 'n' ? [i, 2] : side === 's' ? [i, 13] : side === 'w' ? [2, i] : [13, i];
        ctx.fillRect(x + px * P, y + py * P, P * (side === 'n' || side === 's' ? 2 : 1), P * (side === 'w' || side === 'e' ? 2 : 1));
      }
    }
  }
}

/** 迷雾：`d` = 离已开拓地的距离（1 起），`vision` 以内逐级变暗，外面全黑；`reveal`（0~1）用于刚开拓的淡出 */
export function drawFog(ctx: Ctx, row: number, col: number, d: number, vision: number): void {
  const x = col * T;
  const y = row * T;
  const a = d > vision ? 1 : Math.min(0.42 + (d - 1) * (0.5 / Math.max(vision, 1)), 0.94);
  ctx.globalAlpha = a;
  ctx.fillStyle = '#07050a';
  ctx.fillRect(x, y, T, T);
  // 雾的颗粒感
  ctx.globalAlpha = Math.min(a, 0.6) * 0.5;
  ctx.fillStyle = '#2a2233';
  for (let i = 0; i < 6; i += 1) {
    const r = h(row, col, 200 + i);
    ctx.fillRect(x + (r % 15) * P, y + ((r >>> 8) % 15) * P, P * 2, P);
  }
  ctx.globalAlpha = 1;
}

/** 刚开拓的格：迷雾从中心向外散开（k: 0 → 1） */
export function drawReveal(ctx: Ctx, row: number, col: number, k: number): void {
  if (k >= 1) return;
  const x = col * T;
  const y = row * T;
  ctx.fillStyle = '#07050a';
  for (let py = 0; py < 16; py += 1) {
    for (let px = 0; px < 16; px += 1) {
      const d = Math.hypot(px - 7.5, py - 7.5) / 10.6 + (h(row * 16 + py, col * 16 + px, 7) % 100) / 400;
      if (d > k) ctx.fillRect(x + px * P, y + py * P, P, P);
    }
  }
  ctx.globalAlpha = (1 - k) * 0.8;
  ctx.strokeStyle = '#e8c46a';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 2, y + 2, T - 4, T - 4);
  ctx.globalAlpha = 1;
}

/** 迷雾边缘（可开拓）的提示：虚线金边 */
export function drawFrontierMark(ctx: Ctx, row: number, col: number, pulse: number): void {
  const x = col * T;
  const y = row * T;
  ctx.globalAlpha = 0.25 + 0.3 * pulse;
  ctx.fillStyle = '#e8c46a';
  for (let i = 1; i < 15; i += 3) {
    ctx.fillRect(x + i * P, y + P, P, P);
    ctx.fillRect(x + i * P, y + 14 * P, P, P);
    ctx.fillRect(x + P, y + i * P, P, P);
    ctx.fillRect(x + 14 * P, y + i * P, P, P);
  }
  ctx.globalAlpha = 1;
}

/**
 * 地块等级外观：
 *   1 级「良田」＝ 木栅角 + 犁沟；2 级「石基」＝ 石砌边 + 灯笼；3 级「符文」＝ 发光符文线 + 水晶。
 * `glow`（0~1）＝刚升级时的一次闪光。
 */
export function drawTileLevel(ctx: Ctx, row: number, col: number, lv: number, now: number, glow = 0): void {
  if (lv <= 0 && glow <= 0) return;
  const x = col * T;
  const y = row * T;
  if (lv >= 1) {
    ctx.fillStyle = 'rgba(40,24,12,0.45)';
    for (let i = 0; i < 3; i += 1) ctx.fillRect(x + 4 * P, y + (5 + i * 3) * P, 8 * P, P);
    ctx.fillStyle = '#6b4a2a';
    for (const [cx, cy] of [[1, 1], [14, 1], [1, 14], [14, 14]] as const) ctx.fillRect(x + cx * P, y + (cy - 1) * P, P, P * 2);
    ctx.fillStyle = '#8a6238';
    ctx.fillRect(x + P, y + P, 3 * P, P);
    ctx.fillRect(x + 12 * P, y + P, 3 * P, P);
  }
  if (lv >= 2) {
    ctx.fillStyle = '#6d6a78';
    for (let i = 0; i < 16; i += 2) {
      ctx.fillRect(x + i * P, y + 15 * P, P * 2 - 1, P);
      ctx.fillRect(x, y + i * P, P, P * 2 - 1);
      ctx.fillRect(x + 15 * P, y + i * P, P, P * 2 - 1);
    }
    const f = Math.floor(now / 300) % 2;
    ctx.fillStyle = '#2a1c14';
    ctx.fillRect(x + 13 * P, y + 3 * P, P, 5 * P);
    ctx.fillStyle = f ? '#ffd27a' : '#e8a84a';
    ctx.fillRect(x + 12 * P, y + 3 * P, 3 * P, 2 * P);
  }
  if (lv >= 3) {
    const a = 0.45 + 0.35 * Math.sin(now / 500 + row + col);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#7ff0ff';
    ctx.fillRect(x + 3 * P, y + 8 * P, 10 * P, P);
    ctx.fillRect(x + 8 * P, y + 3 * P, P, 10 * P);
    ctx.fillRect(x + 5 * P, y + 5 * P, P, P);
    ctx.fillRect(x + 10 * P, y + 10 * P, P, P);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#b8f6ff';
    ctx.fillRect(x + 7 * P, y + 6 * P, 2 * P, 3 * P);
    ctx.fillStyle = '#3aa8c8';
    ctx.fillRect(x + 7 * P, y + 9 * P, 2 * P, P);
  }
  if (glow > 0) {
    ctx.globalAlpha = glow * 0.7;
    ctx.fillStyle = '#ffe9a8';
    ctx.fillRect(x, y, T, T);
    ctx.fillRect(x + T / 2 - 3, y - T * glow, 6, T * glow);
    ctx.globalAlpha = 1;
  }
}
