/**
 * features/continent/continent-path — 「导航」的寻路（2026-09-30，契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「导航」）。
 *
 * ★ 与 `useContinentHero.walkTo` 的贪心走位分工：贪心是"点哪走哪"的手感（照抄 demo，逐格试探、不保证到得了），
 *   导航要的是**一定到得了就到得了**——大陆上领地是墙、荒地走不进，贪心会在一堵领地前停下说"走不到"，
 *   而 BFS 会绕过去。两者都只走 `walkable` 的地块（同一份口径），只是"找路"的策略不同。
 * ★ 目标是"**打得到的位置**"而不是目标格本身：怪的本体格不可通行，英雄要站到它**正相邻**的格（`canStrike` 的口径，
 *   曼哈顿 ≤ 1）；废墟可通行，站上去也算。已经够得着 ⇒ 空路（零步）。
 * ★ 纯函数、无 React：可单测（`continent-path.test.ts`），也不读时钟。
 */
import { manhattan, type ContinentTileView } from './continent-view';

export type PathStep = readonly [dr: number, dc: number];

/** 四邻的步（上、下、左、右）——与 D-pad / 键盘的步长同一形状 */
const DIRS: readonly PathStep[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** 寻路防呆上界：世界最大半径 40 ⇒ 81² 格；BFS 本身是线性的，这个上界只是别让坏数据把主线程拖住 */
const VISIT_CAP = 8000;

/**
 * 从 `from` 出发、只经可通行地块，走到与 `target` 曼哈顿 ≤ 1 的一格。
 * 返回步序列（每步 `[dr, dc]`）；已经够得着 ⇒ `[]`；到不了 ⇒ `null`。
 * ★ BFS ⇒ 最短步数；同长度时按 DIRS 顺序确定（同一张图永远同一条路，测试可锁）。
 */
export function pathToStrike(
  tiles: readonly ContinentTileView[],
  from: { row: number; col: number },
  target: { row: number; col: number },
): PathStep[] | null {
  if (manhattan(from, target) <= 1) return [];
  const walkable = new Set<string>();
  for (const t of tiles) if (t.walkable) walkable.add(`${t.row},${t.col}`);
  const startKey = `${from.row},${from.col}`;
  /** 到达每格的上一格与那一步（回溯用） */
  const prev = new Map<string, { key: string; step: PathStep } | null>([[startKey, null]]);
  const queue: Array<{ row: number; col: number; key: string }> = [{ row: from.row, col: from.col, key: startKey }];
  let head = 0;
  let goal: string | null = null;
  while (head < queue.length && prev.size <= VISIT_CAP) {
    const cur = queue[head]!;
    head += 1;
    for (const step of DIRS) {
      const row = cur.row + step[0];
      const col = cur.col + step[1];
      const key = `${row},${col}`;
      if (prev.has(key) || !walkable.has(key)) continue;
      prev.set(key, { key: cur.key, step });
      if (manhattan({ row, col }, target) <= 1) {
        goal = key;
        break;
      }
      queue.push({ row, col, key });
    }
    if (goal) break;
  }
  if (!goal) return null;
  const steps: PathStep[] = [];
  for (let k: string | null = goal; k !== null; ) {
    const p: { key: string; step: PathStep } | null | undefined = prev.get(k);
    if (!p) break;
    steps.push(p.step);
    k = p.key;
  }
  return steps.reverse();
}
