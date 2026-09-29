/**
 * features/continent/monster-art — **一种题型组合 = 一种怪**的像素外观（确定性生成，2026-09-29）。
 *
 * ★ 为什么不再只有一只「遗忘之影」：图鉴按题型序列开了 155 个槽，图上却永远是同一张脸——
 *   "收集"就成了看不见的数字。外观必须跟着怪种走，且**同一组合永远长同一个样子**（零随机：
 *   全部由 `species`（`speciesTypes(id, level)`，本身是稳定哈希）决定）。
 *
 *   第 1 型 → **体型**（判断＝史莱姆、选择＝蝠翼魔、填空＝石魔像、连线＝蛇妖、情景＝幽魂）
 *   第 2 型 → **配色**（没有第 2 型时取第 1 型的配色）；≥2 型的怪**口中含光**（牙口 `w` 换成配色的眼色），
 *            否则 `[判断, 判断]` 与 `[判断]` 会长成同一张脸（题型序列允许重复）
 *   第 3 型 → **饰物**（角 / 王冠 / 第三只眼 / 背刺 / 光环；组合短于 3 时没有）
 *   ⇒ 5 体型 × 5 配色 × (1 + 5) 饰物 = 5 + 25 + 125 = 155 种外观，与图鉴槽**一一对应**（单测锁两两不同）。
 *
 * ★ 与 `app/world/continent-art` 同一套画法（`SpriteMap` + `Palette`，逻辑 12×12，`drawSprite` 放大），
 *   `k` 描边 / `b` 体色 / `B` 高光 / `d` 阴影 / `e` 眼 / `w` 牙口 / `a` 饰物——五个体型共用一张字母表，
 *   于是配色可以独立于体型替换。
 * ★ 野怪与欠账怪**同一张脸**（怪种不因来路而变，图鉴才对得上）；来路的区别画在脚下的魔法阵颜色
 *   与弹窗文案里（`continent-canvas.ts`）。
 */
import type { ContinentQType } from '@sb/shared';
import type { Palette, SpriteMap } from '../../app/hero/hero-sprites';

/** 体型（12×12；前两行留给饰物叠画） */
const BODIES: Record<ContinentQType, SpriteMap> = {
  // 史莱姆：一坨，宽嘴
  judge: [
    '............',
    '............',
    '............',
    '....kkkk....',
    '..kkBBBbkk..',
    '.kBBbbbbbbk.',
    '.kBbkebbekk.',
    'kbbbkkbbkkbk',
    'kbbbbbbbbbbk',
    'kbbbwwwwbbbk',
    'kdbbbbbbbbdk',
    '.kkddddddkk.',
  ],
  // 蝠翼魔：张开的翅膀 + 小身子 + 悬空的脚
  choice: [
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
    '...kk..kk...',
    '............',
  ],
  // 石魔像：方头方脑，粗胳膊
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
  // 蛇妖：昂头，身子盘成 S
  match: [
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
    '............',
  ],
  // 幽魂：兜帽里两点眼，下摆飘成三绺
  scene: [
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
    '............',
  ],
};

/** 饰物：叠在前三行（只落在体型为空的像素上，`a` = 饰物色） */
const ACCENTS: Record<ContinentQType, readonly string[]> = {
  judge: ['..a......a..', '..ka....ak..', '...k....k...'], // 角
  choice: ['...a.aa.a...', '...aaaaaa...', '............'], // 王冠
  fill: ['............', '.....aa.....', '.....ka.....'], // 第三只眼
  match: ['.a...a...a..', '.ka..ka..ka.', '............'], // 背刺
  scene: ['...aaaaaa...', '..a......a..', '............'], // 光环
};

/** 配色（体色 / 高光 / 阴影 / 眼） */
const TONES: Record<ContinentQType, { b: string; B: string; d: string; e: string }> = {
  judge: { b: '#3f6fa8', B: '#79a9e0', d: '#24406a', e: '#ffe27a' }, // 霜蓝
  choice: { b: '#3f8a4f', B: '#7ecf8a', d: '#22502c', e: '#ff5f5f' }, // 苔绿
  fill: { b: '#8a6a2f', B: '#d0a95a', d: '#54401a', e: '#7ff0ff' }, // 琥珀
  match: { b: '#6a3f8a', B: '#b07ed6', d: '#3c2252', e: '#ffe27a' }, // 暮紫
  scene: { b: '#8a3f2f', B: '#e0866a', d: '#52221a', e: '#fff3c4' }, // 余烬
};

const ACCENT_COLOR: Record<ContinentQType, string> = {
  judge: '#e0c36b',
  choice: '#ffd24a',
  fill: '#ff3b6b',
  match: '#c9d2e0',
  scene: '#fff3a0',
};

const BODY_NAME: Record<ContinentQType, string> = { judge: '史莱姆', choice: '蝠翼魔', fill: '石魔像', match: '蛇妖', scene: '幽魂' };
const TONE_NAME: Record<ContinentQType, string> = { judge: '霜蓝', choice: '苔绿', fill: '琥珀', match: '暮紫', scene: '余烬' };
const ACCENT_NAME: Record<ContinentQType, string> = { judge: '角', choice: '王冠', fill: '三目', match: '棘背', scene: '圣环' };

export interface MonsterLook {
  map: SpriteMap;
  pal: Palette;
  /** 俗名（弹窗标题 / 图鉴提示用），如「王冠·霜蓝史莱姆」 */
  name: string;
}

const cache = new Map<string, MonsterLook>();

/**
 * 某个怪种的外观（像素图 + 调色板 + 俗名）。同一 `species` 永远同一结果（带缓存，按 key 复用）。
 * ★ 空序列（理论上没有：有怪必有 ≥1 型）按单型 `judge` 处理，不抛。
 */
export function monsterLook(species: readonly ContinentQType[]): MonsterLook {
  const key = species.join('+') || 'judge';
  const hit = cache.get(key);
  if (hit) return hit;
  const first = species[0] ?? 'judge';
  const toneKey = species[1] ?? first;
  const third = species[2];
  const rows = [...BODIES[first]];
  if (third) {
    const acc = ACCENTS[third];
    for (let r = 0; r < acc.length; r += 1) {
      const base = (rows[r] ?? '').split('');
      (acc[r] ?? '').split('').forEach((ch, i) => {
        if (ch !== '.' && base[i] === '.') base[i] = ch;
      });
      rows[r] = base.join('');
    }
  }
  const tone = TONES[toneKey];
  const grown = species.length >= 2;
  const pal: Palette = { k: '#07050a', w: grown ? tone.e : '#f4efe6', ...tone, a: third ? ACCENT_COLOR[third] : '#e0c36b' };
  const name = `${third ? `${ACCENT_NAME[third]}·` : ''}${TONE_NAME[toneKey]}${BODY_NAME[first]}${grown && !third ? '·成体' : ''}`;
  const look: MonsterLook = { map: rows, pal, name };
  cache.set(key, look);
  return look;
}

/** 有几种不同的外观（＝图鉴槽数；单测锁"外观数与槽数一致"用） */
export function monsterLookCount(): number {
  const n = Object.keys(BODIES).length;
  return n + n * n + n * n * n;
}
