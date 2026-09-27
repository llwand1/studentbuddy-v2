/**
 * hero-sprites — 落地页序章的像素精灵（字符画 → 整数方块）。
 *
 * ★ 画风参照：There Is No Light / Raksasi / Dark Devotion 一路的暗黑像素——
 *   近黑底、血月、单一暖光源、红披风。精灵全部是字符画，**不引入任何位图资源**：
 *   仓库保持「零美术资产依赖」，改一个像素就是改一个字符。
 * ★ 每个字符对应调色板里一种颜色，`.` 与空格为透明；行长不必对齐。
 */
export type Palette = Record<string, string>;
export type SpriteMap = readonly string[];

/** 勇者：钢盔、眼缝微光、左手持发光词典（"把词条化为力量"的那本书） */
export const HERO_MAP: SpriteMap = [
  '......kkkk......',
  '.....khhHHk.....',
  '....khhhhHHk....',
  '....khkkkkhk....',
  '....khkeekhk....',
  '.....khhhhk.....',
  '...kcCkaaakk....',
  '..kcCCkaHakgk...',
  '..kcCkaaaakbgk..',
  '.kcCCkaHaakbgk..',
  '.kcCkkaaaakbbk..',
  '.kcCk.kaaak.kk..',
  'kcCCk.kaaak.....',
  'kcCk..kllllk....',
  'kCk...kl..lk....',
  'kk....kl..lk....',
  '......kk..kk....',
];
export const HERO_PAL: Palette = {
  k: '#07050a', h: '#4d4b5e', H: '#9c99b4', e: '#ffd27a', c: '#5a0f19', C: '#9b1f2c',
  a: '#2e2c3a', l: '#1d1b25', b: '#3b2616', g: '#ffe39a',
};

/** 遗忘之影：兜帽幽魂，红眼。下摆逐帧错位由引擎做 */
export const WRAITH_MAP: SpriteMap = [
  '.....kkkkkk.....',
  '....kppppppk....',
  '...kpPPppppPk...',
  '...kpkkkkkkpk...',
  '..kpkkrkkrkkpk..',
  '..kpkkkkkkkkpk..',
  '..kpkkkkkkkkpk..',
  '.kppkkkkkkkkppk.',
  '.kpppkkkkkkpppk.',
  'kppppppppppppppk',
  'kpPppppppppppPpk',
  'kppppppppppppppk',
  '.kpppppppppppk..',
  '.kppk.kppk.kpk..',
  '..kk...kk...k...',
];
export const WRAITH_PAL: Palette = { k: '#050307', p: '#2b1f3d', P: '#4a3866', r: '#ff3b3b' };

/** 混淆魔：多眼泥团——"好几个答案都像对的" */
export const BLOB_MAP: SpriteMap = [
  '......kkkkkk......',
  '....kkmmmmmmkk....',
  '...kmmMMmmmmmmk...',
  '..kmmyymmmyymmmk..',
  '..kmmykmmmykmmmk..',
  '.kmmmmmmyymmmmmmk.',
  '.kmmmmmmykmmmmmmk.',
  'kmmmmkkkkkkkmmmmmk',
  'kmmmkwkwkwkwkmmmmk',
  'kmmmmkkkkkkkmmmmmk',
  '.kmmmmmmmmmmmmmmk.',
  '..kkmmmkkkmmmmkk..',
  '....kkk...kkkk....',
];
export const BLOB_PAL: Palette = { k: '#050706', m: '#2f3b2a', M: '#4f6343', y: '#e8e36a', w: '#d9d2c0' };

/** 逾期巨像（Boss）：双角石像，胸口一枚红核。引擎以 2 倍绘制 */
export const BOSS_MAP: SpriteMap = [
  '.k................k.',
  'kbk..............kbk',
  'kbbk..kkkkkkkk..kbbk',
  '.kbbkkssssssssk.kbbk',
  '..kbksSssssssSsksbk.',
  '...kssskkssskksssk..',
  '...ksssrrksskrrsssk.',
  '...ksssskkssskksssk.',
  '..kksssssssssssssskk',
  '.kssskssskkkkssskssk',
  'kssssksskrrrrksksssk',
  'ksSssksskrRRrkskssSk',
  'kssssksskrrrrksksssk',
  'ksssk.ksskkkksk.ksssk',
  'kkkk..ksssssssk..kkkk',
  '......ksssk.ksssk....',
  '.....kssssk.kssssk...',
  '.....kkkkkk.kkkkkk...',
];
export const BOSS_PAL: Palette = { k: '#060406', b: '#3a3030', s: '#2a2530', S: '#4b4456', r: '#8f1d24', R: '#ff4a3a' };

/** 词条符文（5×5），弹道头部旋转显示 */
export const RUNE_MAP: SpriteMap = ['..x..', '.xxx.', 'xx.xx', '.xxx.', '..x..'];

const WHITE: Palette = new Proxy({}, { get: () => '#fff4e0' }) as Palette;

/** 按字符画落方块；`flash` 为受击白闪，`flip` 为水平镜像（怪物面朝左） */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  map: SpriteMap,
  pal: Palette,
  x: number,
  y: number,
  opts: { scale?: number; flip?: boolean; flash?: boolean; alpha?: number; rowShift?: (row: number) => number } = {},
): void {
  const s = opts.scale ?? 1;
  const p = opts.flash ? WHITE : pal;
  const w = Math.max(...map.map((r) => r.length));
  ctx.globalAlpha = opts.alpha ?? 1;
  map.forEach((row, ry) => {
    const shift = opts.rowShift ? opts.rowShift(ry) : 0;
    for (let rx = 0; rx < row.length; rx++) {
      const ch = row[rx]!;
      if (ch === '.' || ch === ' ') continue;
      const col = p[ch];
      if (!col) continue;
      const cx = opts.flip ? w - 1 - rx : rx;
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(x + (cx + shift) * s), Math.round(y + ry * s), s, s);
    }
  });
  ctx.globalAlpha = 1;
}

export function spriteSize(map: SpriteMap, scale = 1): { w: number; h: number } {
  return { w: Math.max(...map.map((r) => r.length)) * scale, h: map.length * scale };
}
