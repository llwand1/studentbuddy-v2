/**
 * 游戏化图标集 — **整数网格点阵精灵**（2026-09-26 老板点名的像素风，落位在"数值层"）。
 *
 * ★ **为什么不加进 `icons.tsx`**：那个文件已经 260 行，且它是「学环／练环／忆环／反馈环」
 *   的导航图标，语义是**产品分区**；本文件全是**游戏物件**（宝箱／钥匙／星／火焰／吉祥物）。
 *   混在一起的下场和 `task-list.ts` 的 `TaskItem` 撞名是同一类病：两套语义共用一个命名空间，
 *   改一个要读另一个。
 * ★ **禁 emoji 作图标**（`icons.tsx` 头注 + `terms.css:614`／`:906` 三处同规）⇒ 游戏风最容易
 *   破功的地方就是"宝箱用 🎁 凑一下"。本文件是游戏化所有图标位的唯一来源。
 *
 * ══ 画风改判（★ 这一版起不再是线稿）══
 * 2026-09-25 那版是"多邻国圆钝线稿"（24×24、1.6 描边、round 端点）。老板 09-26 定档
 * 「数值层像素化，卡体保持圆钝饱和」⇒ 本文件**八支图标全部改成点阵精灵**：8×8 网格、
 * 实心格吃 `currentColor`、`shape-rendering="crispEdges"` 关掉抗锯齿。
 * ★ **为什么连钥匙／火焰／任务卡也一起换**：它们和星位、宝箱同屏（顶栏四枚读数、开盒面板），
 *   半套像素半套线稿＝一张屏上两种画风互相拆台，比"不够像素"更糟。
 * ★ **同一批改判掉的两条老注释**：⑴ 「任务卡＝卡＋勾」做不到——勾在这种 knockout 里在 8×8 上
 *   会读成一团，改成「卡＋三道文字线」；⑵ 吉祥物头顶那两根触角闪光去掉了，8 格里它只争
 *   一张脸两条腿，多一笔就变成噪音。
 *
 * ★★ **尺寸这条硬约束**：调用点传的 `size` 必须是 `PIXEL_GRID`（8）的**整数倍**。
 *   9px 里塞 8 格＝一格摊到 1.1 物理像素，`crispEdges` 会把它吸附成忽粗忽细的线——
 *   那不叫像素风，叫糊。这条不是口头规矩，`card-motion.test.ts` 里逐个调用点算过。
 *   ⚠️ 顺带一条被量出来的矛盾：卡墙上**八颗并排的像素星放不下**——`.gm-wall` 是
 *   `minmax(168px, 1fr)`，扣掉 `.gm-card` 左右 padding 各 12px 与 2px 边框，内宽最小 **140px**，
 *   而 8×(16px 星＋2px 间隙)＝142px，再加上与「N 张」角标并排的那 8px 间距就溢出、且被
 *   `.gm-card` 的 `overflow: hidden` 裁掉（★ 这条和 B-020 ④「仪式光芒被白框裁」是同一类病）。
 *   ⇒ **burst 那一排改用实心方块槽**，像素星只出现在常驻的单星位读数（`.cv-starline`、开盒面板那一颗）。
 * ★ 下面九支包装函数一律写成 `<PixelIcon {...props} name="…" />`（spread 在前）：
 *   `SVGProps` 自带一个宽类型的 `name?: string`，`name="chest"` 放在前面会被它覆盖成 `string`
 *   ⇒ `tsc -p packages/web` 直接红。反过来写既修类型，也顺手堵掉"调用点传个 name 进来"。
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** 点阵边长（8×8）。★ 调用点 `size` 必须是它的整数倍，见文件头那条硬约束。 */
export const PIXEL_GRID = 8;

/** 精灵表：每行一个**等长**字符串，`#`＝实心格、`.`＝空。行序＝从上到下。 */
const SPRITE = {
  star: [
    '...##...',
    '..####..',
    '########',
    '########',
    '.######.',
    '..####..',
    '.##..##.',
    '#......#',
  ],
  chest: [
    '.######.',
    '########',
    '........',
    '########',
    '#..##..#',
    '#..##..#',
    '########',
    '########',
  ],
  key: [
    '.####...',
    '.#..#...',
    '.####...',
    '..##....',
    '..##.##.',
    '..######',
    '..##....',
    '..##....',
  ],
  flame: [
    '....#...',
    '...##...',
    '..####..',
    '.######.',
    '#######.',
    '#######.',
    '.#####..',
    '..#.#...',
  ],
  task: [
    '########',
    '#......#',
    '#.####.#',
    '#......#',
    '#.###..#',
    '#......#',
    '#.####.#',
    '########',
  ],
  sparkle: [
    '...#....',
    '...#....',
    '#.###.#.',
    '#######.',
    '#.###.#.',
    '...#....',
    '...#..##',
    '......##',
  ],
  mascot: [
    '########',
    '#......#',
    '#.#..#.#',
    '#......#',
    '#.####.#',
    '#......#',
    '########',
    '.##..##.',
  ],
  lock: [
    '..####..',
    '.#....#.',
    '.#....#.',
    '########',
    '########',
    '###..###',
    '###..###',
    '########',
  ],
  /** 「条词条」那枚读数原先吃的是 `icons.tsx` 的线稿 `CardsIcon`——它和同屏另外四枚像素读数
   *  撞画风（顶栏五枚并排），所以在这里补一支点阵牌面，★ 不动 `icons.tsx`（那是产品分区导航，
   *  导航位跟着改会波及全仓）。 */
  deck: [
    '.######.',
    '.#....#.',
    '.#.##.#.',
    '.#....#.',
    '.####.#.',
    '.#....#.',
    '.#.##.#.',
    '.######.',
  ],
} as const;

type SpriteName = keyof typeof SPRITE;

/** 把点阵按"同一行里连续实心格"合并成一条 `<rect>`：8×8 满铺最多 64 个节点，合并后 ≤16。
 *  ★ 只在模块加载时算一次（`RUNS` 缓存），不在 render 里跑循环——卡墙上这个图标可能出现上百次。 */
const RUNS = new Map<string, ReadonlyArray<readonly [number, number, number]>>();

function runs(name: SpriteName): ReadonlyArray<readonly [number, number, number]> {
  const cached = RUNS.get(name);
  if (cached) return cached;
  const out: [number, number, number][] = [];
  SPRITE[name].forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '#') {
        x += 1;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w] === '#') w += 1;
      out.push([x, y, w]);
      x += w;
    }
  });
  const frozen = Object.freeze(out);
  RUNS.set(name, frozen);
  return frozen;
}

function PixelIcon({ name, size, ...rest }: IconProps & { name: SpriteName }) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox={`0 0 ${PIXEL_GRID} ${PIXEL_GRID}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      {...rest}
    >
      {runs(name).map(([x, y, w]) => (
        <rect key={`${x}-${y}-${w}`} x={x} y={y} width={w} height={1} />
      ))}
    </svg>
  );
}

/** 宝箱 —— 每日开箱入口 / T3 仪式面板主体。第 3 行整行留空＝盖与身之间那道沿口缝 */
export function ChestIcon(props: IconProps) {
  return <PixelIcon {...props} name="chest" />;
}

/** 钥匙 —— 开宝箱的额度（`.gm-stat.gm-key`）。弓里有 2×2 的孔，齿朝右两档 */
export function KeyIcon(props: IconProps) {
  return <PixelIcon {...props} name="key" />;
}

/** 星 —— 卡牌星级。★ 单颗读数用它；卡墙上并排的八颗用方块槽（见文件头那条 144px 实测） */
export function StarIcon(props: IconProps) {
  return <PixelIcon {...props} name="star" />;
}

/** 火焰 —— 连续天数（`.gm-stat.gm-flame`）。底下一行分开两舌是它区别于「水滴」的关键 */
export function FlameIcon(props: IconProps) {
  return <PixelIcon {...props} name="flame" />;
}

/** 任务卡 —— 自动派发的学习任务（`study_task`）。卡框 + 三道文字线（勾在 8×8 上 knockout 不出来） */
export function TaskIcon(props: IconProps) {
  return <PixelIcon {...props} name="task" />;
}

/** 闪光 —— 全息闪卡标题位。一大一小错开，单颗会读成"加号" */
export function SparkleIcon(props: IconProps) {
  return <PixelIcon {...props} name="sparkle" />;
}

/** 小吉祥物「卡灵」—— 引导气泡与空态用。
 *  ★ 刻意**不画猫头鹰**：多邻国是我们的画风参照，不是形象参照，画猫头鹰等于蹭商标。
 *    它长成"一张活过来的词条卡"，正好就是本功能的主角，比借来的动物站得住。 */
export function MascotIcon(props: IconProps) {
  return <PixelIcon {...props} name="mascot" />;
}

/** 锁 —— 额度用完的宝箱（T3 面板上"今天开完了"那一格）。梁闭合＝锁着，孔是 knockout 出来的 */
export function LockIcon(props: IconProps) {
  return <PixelIcon {...props} name="lock" />;
}

/** 牌堆 —— 顶栏「条词条」那枚读数（替掉原先借用的线稿 `CardsIcon`，见 `SPRITE.deck` 那条注释） */
export function DeckIcon(props: IconProps) {
  return <PixelIcon {...props} name="deck" />;
}
