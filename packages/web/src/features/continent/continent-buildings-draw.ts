/**
 * features/continent/continent-buildings-draw — 五种建筑的像素造型（占满配方那几格的外接框）。
 * `rise`（0~1）＝建成时从地面升起 + 金光的过渡；常驻动画（火苗 / 法球 / 旗）靠 `now`。
 */
import type { Building } from '@sb/shared';
import { T } from './continent-terrain-draw';

type Ctx = CanvasRenderingContext2D;
const P = 3;

function box(ctx: Ctx, x: number, y: number, w: number, hh: number, c: string): void {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(hh));
}

export function drawBuilding(ctx: Ctx, b: Building, now: number, rise = 1): void {
  const rows = b.cells.map((c) => c.row);
  const cols = b.cells.map((c) => c.col);
  const x0 = Math.min(...cols) * T;
  const y0 = Math.min(...rows) * T;
  const w = (Math.max(...cols) - Math.min(...cols) + 1) * T;
  const hh = (Math.max(...rows) - Math.min(...rows) + 1) * T;
  const cx = x0 + w / 2;
  const base = y0 + hh - 6;
  ctx.save();
  // 升起：从地面线往上裁出可见部分
  ctx.beginPath();
  ctx.rect(x0 - T, base - (hh + T * 2) * rise, w + T * 2, (hh + T * 2) * rise + 8);
  ctx.clip();
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(cx - w * 0.35, base - 2, w * 0.7, 6);
  const f = Math.floor(now / 160) % 2;
  switch (b.kind) {
    case 'spire': {
      box(ctx, cx - 18, base - 60, 36, 60, '#2e2640');
      box(ctx, cx - 14, base - 58, 6, 56, '#453a60');
      box(ctx, cx - 24, base - 12, 48, 12, '#3a3150');
      box(ctx, cx - 12, base - 96, 24, 38, '#3a3150');
      box(ctx, cx - 16, base - 104, 32, 10, '#5a2a6a');
      box(ctx, cx - 10, base - 118, 20, 14, '#6a3080');
      box(ctx, cx - 4, base - 126, 8, 8, '#7a3a90');
      for (let i = 0; i < 3; i += 1) box(ctx, cx - 3, base - 50 + i * 14, 6, 8, f ? '#b07ed6' : '#d6a8ff');
      const orb = 0.5 + 0.5 * Math.sin(now / 300);
      ctx.globalAlpha = 0.35 + 0.3 * orb;
      box(ctx, cx - 12, base - 150, 24, 24, '#d6a8ff');
      ctx.globalAlpha = 1;
      box(ctx, cx - 6, base - 144, 12, 12, '#f4e6ff');
      break;
    }
    case 'library': {
      box(ctx, x0 + 10, base - 56, w - 20, 56, '#5f5c6e');
      for (let i = 0; i < 4; i += 1) box(ctx, x0 + 18 + i * ((w - 44) / 3), base - 50, 8, 50, '#86829a');
      box(ctx, x0 + 4, base - 66, w - 8, 12, '#3b2616');
      for (let i = 0; i < 5; i += 1) box(ctx, x0 + 12 + i * 6, base - 78 - i * 4, w - 24 - i * 12, 6, i % 2 ? '#5a0f19' : '#7a1a26');
      box(ctx, cx - 9, base - 30, 18, 30, '#2a1c14');
      box(ctx, cx - 14, base - 50, 28, 12, '#e8c46a');
      box(ctx, cx - 10, base - 47, 9, 6, '#f4efe6');
      box(ctx, cx + 1, base - 47, 9, 6, '#f4efe6');
      box(ctx, x0 + 22, base - 40, 10, 10, f ? '#ffd27a' : '#e8a84a');
      box(ctx, x0 + w - 32, base - 40, 10, 10, f ? '#e8a84a' : '#ffd27a');
      break;
    }
    case 'tower': {
      box(ctx, cx - 14, base - 8, 28, 8, '#44482f');
      box(ctx, cx - 10, base - 70, 4, 64, '#6b4a2a');
      box(ctx, cx + 6, base - 70, 4, 64, '#6b4a2a');
      for (let i = 0; i < 4; i += 1) box(ctx, cx - 10, base - 20 - i * 14, 20, 3, '#8a6238');
      box(ctx, cx - 18, base - 84, 36, 16, '#5a3a20');
      box(ctx, cx - 22, base - 96, 44, 12, '#7a1a26');
      box(ctx, cx - 1, base - 118, 3, 24, '#3b2616');
      box(ctx, cx + 2, base - 118 + f * 2, 14, 8, '#e8c46a');
      break;
    }
    case 'camp': {
      for (const [dx, c1, c2] of [[-26, '#7a5a30', '#a8804a'], [10, '#5a0f19', '#9b1f2c']] as const) {
        for (let i = 0; i < 8; i += 1) box(ctx, cx + dx + 8 - i * 2, base - 34 + i * 4, 4 + i * 4, 4, i % 2 ? c1 : c2);
        box(ctx, cx + dx + 8, base - 16, 6, 16, '#1a120c');
      }
      box(ctx, cx - 10, base + 2 - 10, 20, 4, '#3b2616');
      box(ctx, cx - 6, base - 22 - f * 3, 12, 14 + f * 3, '#e8a84a');
      box(ctx, cx - 3, base - 18 - f * 2, 6, 10, '#ffe9a8');
      break;
    }
    case 'stele': {
      box(ctx, cx - 14, base - 6, 28, 6, '#44482f');
      box(ctx, cx - 10, base - 44, 20, 40, '#6d6a78');
      box(ctx, cx - 8, base - 50, 16, 8, '#7c7a88');
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now / 450);
      for (let i = 0; i < 4; i += 1) box(ctx, cx - 5 + (i % 2) * 4, base - 38 + i * 8, 6, P, '#7ff0ff');
      ctx.globalAlpha = 1;
      break;
    }
  }
  ctx.restore();
  if (rise < 1) {
    ctx.globalAlpha = (1 - rise) * 0.8;
    ctx.fillStyle = '#ffe9a8';
    ctx.fillRect(x0, y0, w, hh);
    ctx.globalAlpha = 1;
  }
}
