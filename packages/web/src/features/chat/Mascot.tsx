/**
 * Mascot — 欢迎页的像素团子：16×16 手工点阵 → 横跑合并成 <rect>，零图片资源。
 * 只在 4× 整数倍（64px）下放大，配 shape-rendering=crispEdges 才不会糊成灰边。
 * 配色全在 chat.css 由 --sb-primary 派生；跳动/眨眼的时序也在 CSS（门禁禁内联 style）。
 */

/** 图例：'.' 空 · o 轮廓墨 · L 亮面 · B 本体 · S 暗面 · W 眼神光 · E 眼 · M 嘴 */
export const SPRITE = [
  '................',
  '........oL......',
  '........o.......',
  '.....oooooo.....',
  '....oLLLLLLo....',
  '...oBBBBBBBBo...',
  '..oLBBBBBBBBBo..',
  '.oBBWEBBBBWEBBo.',
  '.oBBEEBBBBEEBBo.',
  '.oLBBBBBBBBBBBo.',
  '.oBBBBBBBBBBBBo.',
  '.oBBBBBMMBBBBBo.',
  '..oBBBBBSSSSSo..',
  '...oBBSSSSSSo...',
  '....oSSSSSSo....',
  '.....oooooo.....',
];

/** 睁眼帧的顶行；合帧与校验都以它为准，挪眼位只需改这一处 */
const LID_TOP = 7;

/** 合帧：眨眼时盖在眼位上——上格填回本体、下格留一格墨，就成了闭眼的那条线 */
export const LID = ['....BB....BB....', '....oo....oo....'];

export const CLS: Record<string, string> = {
  o: 'px-ink',
  E: 'px-ink',
  M: 'px-ink',
  L: 'px-light',
  B: 'px-base',
  S: 'px-shade',
  W: 'px-glint',
};

const SIZE = 16;
/** 睁眼帧里属于眼睛的字母——合帧只准盖这几格，偏一格就会糊出重影 */
const EYE = new Set(['E', 'W']);

/** 点阵与类名映射对不上时不猜，直接列出问题格位（单测把它钉成 0 条） */
export function spriteErrors(): string[] {
  const errs: string[] = [];
  const check = (name: string, rows: string[]) => {
    rows.forEach((row, y) => {
      if (row.length !== SIZE) errs.push(`${name}[${y}] 宽 ${row.length}，应为 ${SIZE}`);
      for (const ch of new Set(row)) {
        if (ch !== '.' && !CLS[ch]) errs.push(`${name}[${y}] 字母 "${ch}" 未登记类名`);
      }
    });
  };
  check('SPRITE', SPRITE);
  check('LID', LID);
  LID.forEach((row, dy) => {
    const y = dy + LID_TOP;
    row.split('').forEach((ch, x) => {
      if (ch !== '.' && !EYE.has(SPRITE[y]?.[x] ?? '.')) {
        errs.push(`LID 第 ${dy} 行第 ${x} 格压在非眼位（SPRITE 为 "${SPRITE[y]?.[x]}"）`);
      }
    });
  });
  return errs;
}

type Pixel = { x: number; y: number; w: number; k: string };

/** 同一行同色连成一格宽的 rect，节点数从 130+ 降到 40 上下 */
function toRuns(rows: string[], y0 = 0): Pixel[] {
  const runs: Pixel[] = [];
  rows.forEach((row, dy) => {
    let x = 0;
    while (x < row.length) {
      const k = row[x] ?? '.';
      if (k !== '.') {
        let w = 1;
        while (x + w < row.length && row[x + w] === k) w += 1;
        runs.push({ x, y: y0 + dy, w, k });
        x += w;
      } else x += 1;
    }
  });
  return runs;
}

const BODY = toRuns(SPRITE);
const LID_RUNS = toRuns(LID, LID_TOP);

function Pixels({ runs }: { runs: Pixel[] }) {
  return (
    <>
      {runs.map((p) => (
        <rect key={`${p.x}-${p.y}-${p.k}`} x={p.x} y={p.y} width={p.w} height={1} className={CLS[p.k]} />
      ))}
    </>
  );
}

export function Mascot() {
  return (
    <span className="welcome-mascot" aria-hidden="true">
      <svg className="mascot-px" viewBox="0 0 16 16" shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
        <Pixels runs={BODY} />
        <g className="mascot-px-lid">
          <Pixels runs={LID_RUNS} />
        </g>
      </svg>
    </span>
  );
}
