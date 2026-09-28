/**
 * features/continent/monster-art — **一种题型组合 = 一种怪**的像素外观（确定性生成）。
 *
 *   第 1 型 → 体型（判断＝史莱姆、选择＝蝠翼魔、填空＝石魔像、连线＝蛇妖、情景＝幽魂）
 *   第 2 型 → 配色（没有第 2 型时取第 1 型的配色）
 *   第 3 型 → 饰物（角 / 王冠 / 第三只眼 / 背刺 / 光环；组合短于 3 时没有）
 *   组合长度 → 体型大小（1 型最小、3 型最大）
 * ⇒ 5 × 5 × 6 种外观，与图鉴 155 个槽一一对得上（同一组合永远长同一个样子）。
 */
import type { ContinentQType } from '@sb/shared';
import type { Palette, SpriteMap } from '../../app/hero/hero-sprites';

const BODIES: Record<ContinentQType, string[]> = {
  judge: [
    '............',
    '............',
    '............',
    '....kkkk....',
    '..kkBBbbkk..',
    '.kBBbbbbbbk.',
    '.kBbkebbekk.',
    'kbbbkkbbkkbk',
    'kbbbbbbbbbbk',
    'kbbbwwwwbbbk',
    'kdbbbbbbbbdk',
    '.kkddddddkk.',
  ],
  choice: [
    '............',
    '............',
    'k....kk....k',
    'kk..kBBk..kk',
    'kBk.kbbk.kBk',
    'kbBkbebekBbk',
    'kbbBbbbbBbbk',
    '.kbbbwwbbbk.',
    '..kkbbbbkk..',
    '....kddk....',
    '....k..k....',
    '............',
  ],
  fill: [
    '............',
    '............',
    '...kkkkkk...',
    '..kBBBBbbk..',
    '..kbekkebk..',
    '.kkbbbbbbkk.',
    'kbkdbbbbdkbk',
    'kbkbbwwbbkbk',
    'kkkbbbbbbkkk',
    '..kbbkkbbk..',
    '..kddk.kddk.',
    '..kkk...kkk.',
  ],
  match: [
    '............',
    '............',
    '......kkk...',
    '.....kBBek..',
    '.....kbbbwk.',
    '....kbbkkk..',
    '...kbbk.....',
    '..kbbk..kk..',
    '.kbbk..kbbk.',
    '.kbbbkkbbdk.',
    '..kdbbbbdk..',
    '...kkkkkk...',
  ],
  scene: [
    '............',
    '............',
    '....kkkk....',
    '...kBBbbk...',
    '..kBkkkkbk..',
    '..kbkekekbk.',
    '..kbkkkkkbk.',
    '.kbbbbbbbbk.',
    '.kbBbbbbbbk.',
    '.kbbbbbbbdk.',
    '.kdbkdbkdbk.',
    '..kk.kk.kk..',
  ],
};

/** 饰物：在前三行叠画（`a` = 饰物色） */
const ACCENTS: Record<ContinentQType, string[]> = {
  judge: ['..a......a..', '..ka....ak..', '...k....k...'], // 角
  choice: ['...a.aa.a...', '...aaaaaa...', '............'], // 王冠
  fill: ['............', '.....aa.....', '.....ka.....'], // 第三只眼
  match: ['.a...a...a..', '.ka..ka..ka.', '............'], // 背刺
  scene: ['...aaaaaa...', '..a......a..', '............'], // 光环
};

const PALS: Record<ContinentQType, { b: string; B: string; d: string; e: string }> = {
  judge: { b: '#3f6fa8', B: '#79a9e0', d: '#24406a', e: '#ffe27a' },
  choice: { b: '#3f8a4f', B: '#7ecf8a', d: '#22502c', e: '#ff5f5f' },
  fill: { b: '#8a6a2f', B: '#d0a95a', d: '#54401a', e: '#7ff0ff' },
  match: { b: '#6a3f8a', B: '#b07ed6', d: '#3c2252', e: '#ffe27a' },
  scene: { b: '#8a3f2f', B: '#e0866a', d: '#52221a', e: '#fff3c4' },
};

const ACCENT_COLOR: Record<ContinentQType, string> = {
  judge: '#e0c36b',
  choice: '#ffd24a',
  fill: '#ff3b6b',
  match: '#c9d2e0',
  scene: '#fff3a0',
};

const cache = new Map<string, { map: SpriteMap; pal: Palette }>();

/** 某个怪种的像素图（12×12）与调色板 */
export function monsterSprite(species: readonly ContinentQType[]): { map: SpriteMap; pal: Palette } {
  const key = species.join('+') || 'judge';
  const hit = cache.get(key);
  if (hit) return hit;
  const first = species[0] ?? 'judge';
  const tone = PALS[species[1] ?? first];
  const map = [...BODIES[first]];
  const third = species[2];
  if (third) {
    const acc = ACCENTS[third];
    for (let r = 0; r < acc.length; r += 1) {
      const base = map[r]!.split('');
      acc[r]!.split('').forEach((ch, i) => {
        if (ch !== '.' && base[i] === '.') base[i] = ch;
      });
      map[r] = base.join('');
    }
  }
  const pal: Palette = { k: '#07050a', w: '#f4efe6', ...tone, a: third ? ACCENT_COLOR[third] : '#e0c36b' };
  const out = { map, pal };
  cache.set(key, out);
  return out;
}

/** 怪的俗名（图鉴 / 弹窗标题用）：体型 + 配色 + 饰物 */
const BODY_NAME: Record<ContinentQType, string> = { judge: '史莱姆', choice: '蝠翼魔', fill: '石魔像', match: '蛇妖', scene: '幽魂' };
const TONE_NAME: Record<ContinentQType, string> = { judge: '霜蓝', choice: '苔绿', fill: '琥珀', match: '暮紫', scene: '余烬' };
const ACC_NAME: Record<ContinentQType, string> = { judge: '角', choice: '王冠', fill: '三目', match: '棘背', scene: '圣环' };

export function monsterName(species: readonly ContinentQType[]): string {
  const first = species[0] ?? 'judge';
  const tone = TONE_NAME[species[1] ?? first];
  const acc = species[2] ? `${ACC_NAME[species[2]]}·` : '';
  return `${acc}${tone}${BODY_NAME[first]}`;
}
