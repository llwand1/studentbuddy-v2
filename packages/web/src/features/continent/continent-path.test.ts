/**
 * continent-path.test — 「导航」寻路的口径锁（2026-09-30）。
 *
 * 为什么单测：`useContinentHero.walkTo` 的贪心走位在一堵领地前会停下说"走不到"，导航承诺的是
 * "点了就一定走到能打的位置"——这条承诺全靠 BFS 兑现。这里不依赖真实地图（只造 `walkable`/坐标），
 * 锁四条：已够得着 ⇒ 空路；直路最短；有墙会绕；四面围死 ⇒ null（页面据此提示，不是默默不动）。
 */
import { describe, it, expect } from 'vitest';
import { pathToStrike } from './continent-path';
import type { ContinentTileView } from './continent-view';

/** 只造寻路用得到的字段：其余字段寻路不读，用断言收窄即可（不引入 any） */
function cell(row: number, col: number, walkable = true): ContinentTileView {
  return { row, col, walkable } as unknown as ContinentTileView;
}

/** `rows` 里 `.` 可走、`#` 墙/荒地、`M` 怪（不可走，作为目标）；左上角是 (0,0) */
function grid(rows: readonly string[]): { tiles: ContinentTileView[]; target: { row: number; col: number } } {
  const tiles: ContinentTileView[] = [];
  let target = { row: -1, col: -1 };
  rows.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      if (ch === 'M') target = { row, col };
      if (ch === '.') tiles.push(cell(row, col, true));
      if (ch === 'M' || ch === '#') tiles.push(cell(row, col, false));
    });
  });
  return { tiles, target };
}

/** 顺着步序列走一遍，返回落点（校验"路是连通且真的到了"） */
function walk(from: { row: number; col: number }, steps: ReadonlyArray<readonly [number, number]>) {
  return steps.reduce((p, [dr, dc]) => ({ row: p.row + dr, col: p.col + dc }), from);
}

describe('pathToStrike', () => {
  it('已经正相邻（曼哈顿 ≤ 1）⇒ 空路，零步就能打', () => {
    const { tiles, target } = grid(['.M']);
    expect(pathToStrike(tiles, { row: 0, col: 0 }, target)).toEqual([]);
  });

  it('直路：走到目标**旁边**就停，不会试图踩进怪的本体格', () => {
    const { tiles, target } = grid(['....M']);
    const path = pathToStrike(tiles, { row: 0, col: 0 }, target);
    expect(path).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
    expect(walk({ row: 0, col: 0 }, path ?? [])).toEqual({ row: 0, col: 3 });
  });

  it('★ 领地是墙：贪心会停在墙前，BFS 绕过去且是最短路', () => {
    const { tiles, target } = grid([
      '.#M',
      '.#.',
      '...',
    ]);
    const from = { row: 0, col: 0 };
    const path = pathToStrike(tiles, from, target);
    expect(path).not.toBeNull();
    // 绕行：下、下、右、右、上 ⇒ 停在 (1,2)，与 (0,2) 相邻
    expect(path).toHaveLength(5);
    const end = walk(from, path ?? []);
    expect(Math.abs(end.row - target.row) + Math.abs(end.col - target.col)).toBeLessThanOrEqual(1);
    // 每一步都落在可走格上
    let p = from;
    for (const s of path ?? []) {
      p = { row: p.row + s[0], col: p.col + s[1] };
      expect(tiles.find((t) => t.row === p.row && t.col === p.col)?.walkable).toBe(true);
    }
  });

  it('四面围死 ⇒ null（页面拿它提示"走不到"，而不是默默不动）', () => {
    const { tiles, target } = grid([
      '.#M',
      '.##',
      '.##',
    ]);
    expect(pathToStrike(tiles, { row: 0, col: 0 }, target)).toBeNull();
  });

  it('同一张图、同一起点终点 ⇒ 永远同一条路（BFS 方向顺序固定）', () => {
    const { tiles, target } = grid([
      '.....',
      '.....',
      '..M..',
    ]);
    const a = pathToStrike(tiles, { row: 0, col: 0 }, target);
    const b = pathToStrike(tiles, { row: 0, col: 0 }, target);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3); // (0,0)→(2,1) 或 (1,2)：都是 3 步
  });
});
