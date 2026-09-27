/**
 * continent-art — 知识大陆俯视图的像素美术（地砖调色、道具、小人精灵）。
 *
 * ★ 画风：俯视平面 + 竖立的"纸片"道具（饥荒式），地砖带 4px 侧面厚度（HD-2D 的立体感），
 *   夜色与侵蚀用紫黑（最后的咒语式的夜晚魔法阵）。零位图资源。
 */
import type { Domain } from './world-copy';
import type { Palette, SpriteMap } from '../hero/hero-sprites';

export type TilePal = { top: string; lite: string; dark: string; side: string };

export const TILE_PAL: Record<Domain | 'corrupt', TilePal> = {
  bio: { top: '#4a7437', lite: '#6f9a4f', dark: '#3a5c2b', side: '#253c1b' },
  phy: { top: '#5f5c6e', lite: '#86829a', dark: '#4a4858', side: '#2c2a36' },
  learn: { top: '#a88e55', lite: '#cdb679', dark: '#8a7342', side: '#584728' },
  chem: { top: '#3b5a57', lite: '#5b8680', dark: '#2d4744', side: '#1a2d2b' },
  corrupt: { top: '#3a1d3e', lite: '#6a3072', dark: '#28122b', side: '#170a19' },
};

/** 俯视小勇者（红披风延续首屏角色） */
export const CHIBI_MAP: SpriteMap = [
  '..kkkk..',
  '.khhHHk.',
  '.khkekk.',
  '.kkhhkk.',
  'kcaaaagk',
  'kcaHaabk',
  'kcaaaak.',
  '.klkklk.',
  '.kk..kk.',
];
export const CHIBI_PAL: Palette = { k: '#07050a', h: '#4d4b5e', H: '#9c99b4', e: '#ffd27a', c: '#9b1f2c', a: '#2e2c3a', l: '#1d1b25', g: '#ffe39a', b: '#3b2616' };

/** 俯视小怪：遗忘之影（缩小版） */
export const SHADE_MAP: SpriteMap = [
  '...kkkk...',
  '..kppppk..',
  '.kpkkkkpk.',
  '.kkrkkrkk.',
  '.kpkkkkpk.',
  'kppppppppk',
  'kpPppppPpk',
  '.kpkppkpk.',
  '..k..k..k.',
];
export const SHADE_PAL: Palette = { k: '#050307', p: '#2b1f3d', P: '#4a3866', r: '#ff3b3b' };

type Ctx = CanvasRenderingContext2D;

/** 地砖：顶面 + 纹理点 + 侧面厚度；`seed` 决定纹理，`glow` 为新落地/收复时的描边亮度 */
export function drawTile(c: Ctx, x: number, y: number, T: number, pal: TilePal, seed: number, glow: number): void {
  const th = Math.round(T * 0.75);
  c.fillStyle = pal.side;
  c.fillRect(x, y + th, T, 4);
  c.fillStyle = pal.top;
  c.fillRect(x, y, T, th);
  c.fillStyle = pal.lite;
  c.fillRect(x, y, T, 1);
  for (let i = 0; i < 4; i++) {
    const h = (seed * (i + 3) * 2654435761) >>> 0;
    c.fillStyle = i % 2 ? pal.lite : pal.dark;
    c.fillRect(x + 1 + (h % (T - 3)), y + 2 + ((h >> 8) % (th - 3)), 2, 1);
  }
  c.fillStyle = pal.dark;
  c.fillRect(x + T - 1, y, 1, th);
  if (glow > 0) {
    c.globalAlpha = glow;
    c.fillStyle = '#ffe39a';
    c.fillRect(x, y, T, 1);
    c.fillRect(x, y + th - 1, T, 1);
    c.fillRect(x, y, 1, th);
    c.fillRect(x + T - 1, y, 1, th);
    c.globalAlpha = 1;
  }
}

/** 竖立道具（饥荒式纸片）：按种子挑树 / 石 / 蘑菇 / 草丛 / 无 */
export function drawProp(c: Ctx, x: number, y: number, seed: number, domain: Domain, t: number): void {
  const k = seed % 7;
  const cx = x + 4 + (seed % 5);
  if (k === 0 || k === 1) {
    if (domain === 'learn') {
      // 沙原：枯柱
      c.fillStyle = '#3a2e1c';
      c.fillRect(cx, y - 9, 3, 12);
      c.fillStyle = '#5c4a2c';
      c.fillRect(cx, y - 9, 1, 12);
      return;
    }
    // 细长的歪树（饥荒味）
    const sway = Math.round(Math.sin(t * 1.5 + seed) * 1);
    c.fillStyle = '#1a120e';
    c.fillRect(cx + 1, y - 10, 2, 13);
    c.fillStyle = domain === 'chem' ? '#2c4a3c' : domain === 'phy' ? '#3a3a44' : '#2d4a22';
    c.fillRect(cx - 3 + sway, y - 16, 9, 5);
    c.fillRect(cx - 1 + sway, y - 19, 5, 3);
    c.fillStyle = domain === 'chem' ? '#3f6a55' : domain === 'phy' ? '#55556a' : '#447030';
    c.fillRect(cx - 2 + sway, y - 16, 4, 2);
  } else if (k === 2) {
    c.fillStyle = '#2a2830';
    c.fillRect(cx - 1, y - 3, 7, 5);
    c.fillStyle = '#4a4756';
    c.fillRect(cx, y - 4, 5, 2);
  } else if (k === 3) {
    c.fillStyle = '#d9d2c0';
    c.fillRect(cx + 1, y - 2, 1, 3);
    c.fillStyle = domain === 'chem' ? '#7a4a9a' : '#b8262f';
    c.fillRect(cx - 1, y - 4, 5, 2);
    c.fillStyle = '#fff4e0';
    c.fillRect(cx, y - 4, 1, 1);
  } else if (k === 4) {
    c.fillStyle = domain === 'learn' ? '#6e5c34' : '#2e4a22';
    c.fillRect(cx, y - 3, 1, 3);
    c.fillRect(cx + 2, y - 4, 1, 4);
    c.fillRect(cx + 4, y - 2, 1, 2);
  }
}

/** 最后的咒语式魔法阵：怪物脚下的阶梯旋转符环 */
export function drawSigil(c: Ctx, cx: number, cy: number, r: number, t: number): void {
  const n = 16;
  const rot = Math.floor(t * 6) / 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rot;
    c.fillStyle = i % 4 === 0 ? '#ff4a6a' : '#8a2a6a';
    c.fillRect(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * 0.6), i % 4 === 0 ? 2 : 1, 1);
  }
}
