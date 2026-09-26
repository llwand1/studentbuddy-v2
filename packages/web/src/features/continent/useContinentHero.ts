/**
 * features/continent/useContinentHero — 英雄走位（纯前端状态，**零存储、零写口**）。
 *
 * ★ 为什么走位不进服务端：它在 demo 里就只是"玩家站在哪"，与复习进度无关。
 *   落库等于给一个纯演出加一次网络往返与一张表，而本仓的判据是「三个月后它会被删吗」。
 *   ⇒ 位置只活在会话里：刷新后英雄回到中心那块可通行地（`initialHeroCell`）。
 *
 * ★ 走到哪里算"路"：只有**可通行**的地块（`walkable` = 有词条 且 不属于任何怪的本体/领地）。
 *   荒地和怪的领地一律走不进去——这不是刁难，正是 demo 里走位的意义：
 *   领地是墙，于是"绕路/先打怪"才成为一个选择（`shared/continent.ts` 头注 4）。
 *
 * ★ 寻路口径照抄 demo 的 `walk_to`：四方向贪心，先走位移大的那根轴，逐格试探。
 *   ★ 它**不保证最短路**（demo 也不保证），但**保证确定性**且永不绕圈：
 *   每步都严格减小与目标的曼哈顿距离，`guard` 只是防呆上界。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { initialHeroCell, type ContinentTileView } from './continent-view';

/** 一格走多久（demo 是 90ms 插值；这里取 130ms —— 更慢一点，像素脚步看得清）。
 *  ★ 导出给 `continent-canvas.ts` 的插值用：走一格 = 一步插值，两处必须是同一个数。 */
export const STEP_MS = 130;
/** 寻路防呆上界（demo 的 `guard < 40`） */
const PATH_GUARD = 48;

export type HeroFace = 'up' | 'down' | 'left' | 'right';

export interface HeroCell {
  row: number;
  col: number;
  face: HeroFace;
}

export interface ContinentHero {
  hero: HeroCell | null;
  /** 上一步的起点（canvas 用它做插值；`null` = 没在动） */
  animFrom: { row: number; col: number } | null;
  /** 插值起始时刻（`performance.now()`） */
  animStart: number;
  /** 队列里还有几步 */
  queued: number;
  /** 最近一次被挡住的原因（ADR-5 禁静默：走不动要说出来） */
  blocked: string | null;
  clearBlocked: () => void;
  /** 走一步（键盘/方向键）。连着按会排队。 */
  step: (dr: number, dc: number) => void;
  /** 点地图寻路（远则排队走过去） */
  walkTo: (row: number, col: number) => void;
  /** 清空走位队列（打开弹窗/切页时别让它继续走） */
  halt: () => void;
}

function faceOf(dr: number, dc: number): HeroFace {
  if (dr < 0) return 'up';
  if (dr > 0) return 'down';
  if (dc < 0) return 'left';
  return 'right';
}

export function useContinentHero(tiles: readonly ContinentTileView[]): ContinentHero {
  const [hero, setHero] = useState<HeroCell | null>(null);
  const [queued, setQueued] = useState(0);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [anim, setAnim] = useState<{ from: { row: number; col: number }; at: number } | null>(null);

  const queueRef = useRef<Array<[number, number]>>([]);
  const heroRef = useRef<HeroCell | null>(null);
  heroRef.current = hero;
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;

  const walkableAt = useCallback(
    (row: number, col: number): boolean =>
      tilesRef.current.some((t) => t.row === row && t.col === col && t.walkable),
    [],
  );

  // 落脚点：首挂载取 `initialHeroCell`；刷新后若脚下那一格不再可通行（怪占了/词条删了）也重取
  useEffect(() => {
    const cur = heroRef.current;
    if (cur && tiles.some((t) => t.row === cur.row && t.col === cur.col && t.walkable)) return;
    const start = initialHeroCell(tiles);
    setHero(start ? { row: start.row, col: start.col, face: cur?.face ?? 'down' } : null);
    queueRef.current = [];
    setQueued(0);
  }, [tiles]);

  const halt = useCallback(() => {
    queueRef.current = [];
    setQueued(0);
  }, []);

  // 队列步进：每 STEP_MS 走一格；被挡则清空队列并念一句（不静默吞掉）
  const shouldTick = queued > 0;
  useEffect(() => {
    if (!shouldTick) return;
    const t = setInterval(() => {
      const q = queueRef.current;
      const next = q.shift();
      if (!next) {
        setQueued(0);
        return;
      }
      setQueued(q.length);
      const cur = heroRef.current;
      if (!cur) return;
      const [dr, dc] = next;
      const row = cur.row + dr;
      const col = cur.col + dc;
      if (!walkableAt(row, col)) {
        queueRef.current = [];
        setQueued(0);
        setBlocked('前面走不过去——荒地和怪的领地都挡路，先清怪或者绕开。');
        return;
      }
      setAnim({ from: { row: cur.row, col: cur.col }, at: performance.now() });
      setHero({ row, col, face: faceOf(dr, dc) });
    }, STEP_MS);
    return () => clearInterval(t);
  }, [shouldTick, walkableAt]);

  const step = useCallback(
    (dr: number, dc: number) => {
      if (!dr && !dc) return;
      setBlocked(null);
      queueRef.current = [...queueRef.current, [dr, dc]];
      setQueued(queueRef.current.length);
    },
    [],
  );

  const walkTo = useCallback(
    (targetRow: number, targetCol: number) => {
      const cur = heroRef.current;
      if (!cur) return;
      if (cur.row === targetRow && cur.col === targetCol) return;
      const steps: Array<[number, number]> = [];
      let row = cur.row;
      let col = cur.col;
      let guard = 0;
      while ((row !== targetRow || col !== targetCol) && guard < PATH_GUARD) {
        guard += 1;
        const dr = targetRow - row;
        const dc = targetCol - col;
        // 先走位移大的那根轴；该轴被挡就试另一根（demo 的 tryOrder 同款）
        const order: Array<[number, number]> =
          Math.abs(dr) >= Math.abs(dc)
            ? [
                [Math.sign(dr), 0],
                [0, Math.sign(dc)],
              ]
            : [
                [0, Math.sign(dc)],
                [Math.sign(dr), 0],
              ];
        let moved = false;
        for (const [sr, sc] of order) {
          if (!sr && !sc) continue;
          if (walkableAt(row + sr, col + sc)) {
            steps.push([sr, sc]);
            row += sr;
            col += sc;
            moved = true;
            break;
          }
        }
        if (!moved) break;
      }
      if (!steps.length) {
        setBlocked('走不到那一格——荒地或怪的领地挡着，先清怪再过去。');
        return;
      }
      setBlocked(null);
      queueRef.current = steps;
      setQueued(steps.length);
    },
    [walkableAt],
  );

  const clearBlocked = useCallback(() => setBlocked(null), []);

  return { hero, animFrom: anim?.from ?? null, animStart: anim?.at ?? 0, queued, blocked, clearBlocked, step, walkTo, halt };
}