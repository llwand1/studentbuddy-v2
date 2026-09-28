/**
 * spell-fx-art — 魔法吟唱五款释放特效的调色板与字符画精灵（契约 docs/SPELL-CHANT-SPEC.md §3.4）。
 *
 * ★ 画风参照 There Is No Light（无光斩）/ Blasphemous 2（悔罪光柱）/ Momodora: Moonlit Farewell（月下叶舞）/
 *   Record of Lodoss War: Deedlit in Wonder Labyrinth（风灵旋刃 · 炎蛇）那一路**手绘逐帧像素特效**：
 *   每款一套 6–8 色、互不串色的调色板——测试锁「一款只用自己的颜色」，串色一眼就能被机器抓到。
 * ★ 与 `hero-sprites` 同纪律：精灵全是字符画，`.` 为透明，**不引入任何位图资源**；旋转由 `rotateMap` 现算，
 *   一片叶子只画一次就有四个朝向。
 */
import type { SpriteMap } from '../../app/hero/hero-sprites';

export const FX_PAL = {
  /** 无光斩：近黑、干血、鲜血、骨白——There Is No Light 的黑白红 */
  dusk: { ink: '#07050a', dusk: '#1a0d12', blood: '#5a0f19', red: '#c8202f', bright: '#ff2a3c', bone: '#f4f0f5', ash: '#6a6572' },
  /** 悔罪光柱：金与青铜的圣光、深褐荆棘、蓝白奇迹之焰——Blasphemous 的金蓝对撞 */
  grace: { dark: '#2a1206', bronze: '#b5651d', amber: '#f2b632', gold: '#ffe9a3', white: '#fff8e6', flame: '#7fd7ff', pale: '#cfefff' },
  /** 月下叶舞：夜紫、枫红、珊瑚、月白、薄荷绿——Momodora 的柔光夜色 */
  leaf: { night: '#1a1430', brown: '#8a3a2a', coral: '#ff9b54', pink: '#e8567a', pale: '#ffe6f0', moon: '#f7f3d0', teal: '#7de0c3', deep: '#2f8f7c' },
  /** 风灵旋刃：深林绿到近白的薄荷——Deedlit 的风之精灵 Sylph */
  sylph: { shade: '#0f2e1f', deep: '#1d5c3a', green: '#3ddc84', gust: '#8be8b2', mint: '#b8ffd9', white: '#f2fff8' },
  /** 炎蛇：焦黑、余烬、橙红、焰黄、烟灰——Deedlit 的火之精灵 Salamander */
  salamander: { dark: '#2a0a0a', ember: '#8a1a0e', red: '#ff5e1a', orange: '#ffb52e', yellow: '#fff1b0', white: '#fffbe8', smoke: '#4a3c44', soot: '#2e252c' },
} as const;

export type FxPalette = (typeof FX_PAL)[keyof typeof FX_PAL];

/** 枫叶（茎朝下）：a 叶缘 / b 叶身 / c 茎 */
export const LEAF_MAP: SpriteMap = ['..a.a..', '.aabaa.', 'aabbbaa', '.abbba.', '..aba..', '...b...', '...c...'];

/** 羽毛（斜向）：w 羽面 / W 羽轴 */
export const FEATHER_MAP: SpriteMap = ['...w', '..Ww', '.wW.', 'ww..'];

/** 叶舞命中时的花形印记（Momodora 的枫叶徽记味道） */
export const BLOOM_MAP: SpriteMap = ['....x....', '...xxx...', '.x.xxx.x.', 'xxxx.xxxx', '.xxx.xxx.', 'xxxx.xxxx', '.x.xxx.x.', '...xxx...', '....x....'];

/** 荆棘（一根，从底部长出）：t 暗 / T 亮 */
export const THORN_MAP: SpriteMap = ['....T', '...Tt', '...Tt', '..Tt.', '..Tt.', '.Ttt.', '.Ttt.', 'Tttt.', 'ttttt'];

/** 顺时针转 90°（行列互换后逐行反转）；`times` 取 0–3 */
export function rotateMap(map: SpriteMap, times: number): SpriteMap {
  let cur: string[] = [...map];
  for (let n = 0; n < ((times % 4) + 4) % 4; n += 1) {
    const w = Math.max(...cur.map((r) => r.length));
    const padded = cur.map((r) => r.padEnd(w, '.'));
    const next: string[] = [];
    for (let x = 0; x < w; x += 1) {
      let row = '';
      for (let y = padded.length - 1; y >= 0; y -= 1) row += padded[y]![x]!;
      next.push(row);
    }
    cur = next;
  }
  return cur;
}
