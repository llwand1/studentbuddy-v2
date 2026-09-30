/**
 * lantern-sprite —— 引路灯图标的 16×16 手工点阵（同 `features/chat/Mascot.tsx` 的做法：点阵 → 横向合并成 <rect>，零图片资源）。
 *
 * 灯体不动，火苗两帧交替（CSS `steps()`，关动效时只剩第一帧）。火苗配色取自既有篝火（PixelScene 的 scene-fire-*）。
 * 图例：'.' 空 · o 轮廓墨 · M 金属 · m 金属亮面 · G 灯罩玻璃 · g 火光映暖的玻璃 · R/F/Y 火苗外/中/芯 · w 高光
 */
export const SIZE = 16;

export const BODY = [
  '......oooo......',
  '.....oMmmMo.....',
  '.....oM..Mo.....',
  '....oooMMooo....',
  '...oMmmmmmmMo...',
  '...oMMMMMMMMo...',
  '...oMGggggGMo...',
  '...oMwggggGMo...',
  '...oMGggggGMo...',
  '...oMGggggGMo...',
  '...oMGGggGGMo...',
  '...oMMMMMMMMo...',
  '....oMmmmmMo....',
  '.....ooMMoo.....',
  '......oMMo......',
  '.......oo.......',
];

const E = '................';
/** 火苗只画在灯罩里（第 6–10 行）；两帧的尖端左右摆一格 */
export const FLAME_A = [E, E, E, E, E, E, '.......R........', '......RFR.......', '......RFYR......', '......RYYR......', '.......RR.......', E, E, E, E, E];
export const FLAME_B = [E, E, E, E, E, E, '........R.......', '.......RFR......', '......RFYR......', '......RYYR......', '.......RR.......', E, E, E, E, E];

/** 字母 → CSS 类名（颜色全在 guide.css） */
export const LEGEND: Record<string, string> = {
  o: 'lt-ink',
  M: 'lt-metal',
  m: 'lt-metal-hi',
  G: 'lt-glass',
  g: 'lt-glow',
  R: 'lt-flame-out',
  F: 'lt-flame-mid',
  Y: 'lt-flame-core',
  w: 'lt-glint',
};

/** 点阵与图例对不上时不猜，直接列出问题格位（单测把它钉成 0 条） */
export function lanternSpriteErrors(): string[] {
  const errs: string[] = [];
  const check = (name: string, rows: string[]): void => {
    if (rows.length !== SIZE) errs.push(`${name} 高 ${rows.length}，应为 ${SIZE}`);
    rows.forEach((row, y) => {
      if (row.length !== SIZE) errs.push(`${name}[${y}] 宽 ${row.length}，应为 ${SIZE}`);
      for (const ch of new Set(row)) {
        if (ch !== '.' && !LEGEND[ch]) errs.push(`${name}[${y}] 字母 "${ch}" 未登记类名`);
      }
    });
  };
  check('BODY', BODY);
  check('FLAME_A', FLAME_A);
  check('FLAME_B', FLAME_B);
  // 火苗只许盖在灯罩玻璃（G / g）上：盖到金属或轮廓上就是点歪了一格
  for (const [name, rows] of [['FLAME_A', FLAME_A], ['FLAME_B', FLAME_B]] as const) {
    rows.forEach((row, y) => {
      row.split('').forEach((ch, x) => {
        if (ch === '.') return;
        const under = BODY[y]?.[x] ?? '.';
        if (under !== 'G' && under !== 'g') errs.push(`${name}[${y}][${x}] 火苗压在非玻璃格（BODY 为 "${under}"）`);
      });
    });
  }
  return errs;
}
