/**
 * features/continent/ContinentMap — 知识大陆地图（canvas 像素，交互在本文件、绘制在 `continent-canvas.ts`）。
 *
 * 三层分工：
 *   ① 口径层 `continent-view.ts`：谁有怪、几级、哪格是谁的领地、哪格能站人；
 *   ② 绘制层 `continent-canvas.ts`：给定状态画什么（纯 canvas 指令）；
 *   ③ 本文件：**命中换算 + 悬停 + 点击上报**（点击的语义分流在页面，因为那需要知道"英雄在哪"）。
 *
 * ★ 命中判定用 `getBoundingClientRect` 的尺寸比例，**不写死 48px**：canvas 被 CSS 缩放
 *   （窄屏 `max-width:100%`）后，写死的坐标会把点击算到隔壁格。
 * ★ 命中只上报**格子坐标**（`onPick(row, col)`），不上报对象：怪的领地可能落在**没有词条的荒地**
 *   上（`view.wildLands`），那不是 `ContinentTileView`——上报坐标，调用方才能把两种格都接住。
 * ★ 抽帧粒度：只在「地形指纹变了 / 有击杀特效 / 英雄正在走」时开 requestAnimationFrame，
 *   静止时**不开循环**——地图是常驻页，一个白跑的空转循环等于持续耗电（同 `CardWall` 的取舍）。
 * ★ 重放「长出来」的判据是**地形指纹**（`tilesKey`，含领地归属）：点一下弹窗不该让整张图重长一遍。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONTINENT_COLS, CONTINENT_ROWS } from '@sb/shared';
import {
  BURST_MS,
  CANVAS_H,
  CANVAS_W,
  COLOR,
  POP_MS,
  STAGGER_CAP,
  STAGGER_MS,
  drawBackground,
  drawBurst,
  drawChest,
  drawFrame,
  drawHero,
  drawLand,
  drawMonster,
  drawSprout,
  drawTile,
} from './continent-canvas';
import { STEP_MS, type HeroCell } from './useContinentHero';
import { tileHint, type ContinentLandCell, type ContinentTileView } from './continent-view';

/** 地上的一只宝箱（打怪掉落；**只有位置与词条名，没有账**——开箱走既有每日宝箱账本） */
export interface ContinentChestDrop {
  row: number;
  col: number;
  term: string;
}

/** 一个格子（可能是真词条格，也可能是荒地上的领地格） */
export interface ContinentCell {
  row: number;
  col: number;
}

interface Props {
  tiles: ContinentTileView[];
  /** 荒地上的领地格（`tiles` 装不下的那些）——不画它们，一整片占领区就看不见 */
  wildLands: readonly ContinentLandCell[];
  hero: HeroCell | null;
  heroFrom: { row: number; col: number } | null;
  /** 这一步的起始时刻（`performance.now()`），插值用 */
  heroStart: number;
  chests: readonly ContinentChestDrop[];
  onPick: (row: number, col: number) => void;
  /** 击杀/收复特效：父组件每次换一个新对象（引用变 = 触发一次） */
  burst?: ContinentTileView | null;
  /** 外部高亮（答题弹窗打开时锁住那一格） */
  focus?: ContinentTileView | null;
  /** 走位被挡 / 够不着的一句说明（ADR-5 禁静默）；给了就顶掉默认提示行 */
  alert?: string | null;
}

export function ContinentMap({
  tiles,
  wildLands,
  hero,
  heroFrom,
  heroStart,
  chests,
  onPick,
  burst = null,
  focus = null,
  alert = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverRef = useRef<ContinentCell | null>(null);
  const [hover, setHover] = useState<ContinentCell | null>(null);
  const popRef = useRef({ key: '', start: 0 });
  const burstRef = useRef<{ start: number; tile: ContinentTileView } | null>(null);

  /** 地形指纹：含**领地归属**（怪被收复 ⇒ 整片领地易主 ⇒ 该重长一次，看得见"地回来了"） */
  const tilesKey = useMemo(
    () =>
      `${tiles
        .map((t) => `${t.id}:${t.status}:${t.stage}:${t.hasMonster ? 1 : 0}:${t.landOwner ?? ''}`)
        .join('|')}#${wildLands.map((l) => `${l.row},${l.col}:${l.owner}`).join('|')}`,
    [tiles, wildLands],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (popRef.current.key !== tilesKey) popRef.current = { key: tilesKey, start: performance.now() };
    if (burst) burstRef.current = { start: performance.now(), tile: burst };
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // 降级只去掉"运动"，保留"结果可见"：不插值、不浮动、不播特效（与 CardWall 同一口径）
    if (reducedMotion) burstRef.current = null;
    let raf = 0;
    const step = (): void => {
      const now = performance.now();
      const popAge = reducedMotion ? Number.POSITIVE_INFINITY : now - popRef.current.start;
      const pulse = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(now / 620);
      const popAt = (delay: number): number =>
        Math.max(Math.min((popAge - Math.min(delay, STAGGER_CAP * STAGGER_MS)) / POP_MS, 1), 0.001);
      const popOf = (i: number): number => popAt(i * STAGGER_MS);

      drawBackground(ctx);
      tiles.forEach((t, i) => {
        const pop = popOf(i);
        drawTile(ctx, t, pop);
        if (t.isLand) drawLand(ctx, t, pop, pulse);
        else if (!t.hasMonster) drawSprout(ctx, t, pop);
      });
      // 荒地上的领地：地块本身没铺词条（也就没有 tile），但仍要被占领、要挡路、要能点
      const wildPop = popAt(tiles.length * STAGGER_MS);
      wildLands.forEach((l) => drawLand(ctx, l, wildPop, pulse));
      // 宝箱画在怪下面：它是"地上的东西"，不该盖住怪的脸
      const bob = reducedMotion ? 0 : Math.round(Math.sin(now / 380) * 2);
      chests.forEach((c, i) => drawChest(ctx, c.row, c.col, bob + (i % 2)));
      tiles.forEach((t, i) => {
        if (t.hasMonster) drawMonster(ctx, t, popOf(i));
      });
      if (hero) drawHero(ctx, hero, heroFrom, reducedMotion || !heroFrom ? 1 : Math.min((now - heroStart) / STEP_MS, 1));

      const carried = burstRef.current;
      if (carried) {
        const age = now - carried.start;
        if (age < BURST_MS) drawBurst(ctx, carried.tile, age);
        else burstRef.current = null;
      }
      if (focus) drawFrame(ctx, focus, COLOR.gold, popAge);
      if (hoverRef.current) drawFrame(ctx, hoverRef.current, COLOR.hover, popAge);

      const bAge = burstRef.current ? now - burstRef.current.start : Number.POSITIVE_INFINITY;
      if (popAge < STAGGER_CAP * STAGGER_MS + POP_MS + 40 || bAge < BURST_MS || now - heroStart < STEP_MS + 60) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [tiles, wildLands, tilesKey, hover, focus, burst, hero, heroFrom, heroStart, chests]);

  /** 事件坐标 → 格子；用 rect 比例换算，CSS 缩放后也准 */
  const at = (canvas: HTMLCanvasElement, clientX: number, clientY: number): ContinentCell | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const col = Math.floor(((clientX - rect.left) / rect.width) * CONTINENT_COLS);
    const row = Math.floor(((clientY - rect.top) / rect.height) * CONTINENT_ROWS);
    if (row < 0 || row >= CONTINENT_ROWS || col < 0 || col >= CONTINENT_COLS) return null;
    return { row, col };
  };

  /** 悬停文案：词条格走 `tileHint`（唯一文案源），荒地上的领地格单独说一句 */
  const hintOf = (cell: ContinentCell | null): string | null => {
    if (!cell) return null;
    const t = tiles.find((x) => x.row === cell.row && x.col === cell.col);
    if (t) return tileHint(t);
    const w = wildLands.find((x) => x.row === cell.row && x.col === cell.col);
    if (w) return `「${w.ownerTerm ?? ''}」怪的领地（荒地）· 领主共占 ${w.count} 格 · 点它复习领主`;
    return '这一格还没铺上词条（走不过去）· 去「词条」页多存几条，它会从中心长出来';
  };

  const hoverText = hintOf(hover);

  return (
    <div className="continent-map-wrap">
      <canvas
        ref={canvasRef}
        className="continent-map"
        width={CANVAS_W}
        height={CANVAS_H}
        aria-label="知识大陆地图"
        onMouseMove={(e) => {
          const cell = at(e.currentTarget, e.clientX, e.clientY);
          hoverRef.current = cell;
          if (cell?.row !== hover?.row || cell?.col !== hover?.col) setHover(cell);
        }}
        onMouseLeave={() => {
          hoverRef.current = null;
          setHover(null);
        }}
        onClick={(e) => {
          const cell = at(e.currentTarget, e.clientX, e.clientY);
          if (cell) onPick(cell.row, cell.col);
        }}
      />
      <p className={alert ? 'continent-map-hint warn' : 'continent-map-hint'}>
        {alert ??
          hoverText ??
          `共 ${tiles.length} 格 · 方向键/WASD 或点地走位 · 走到怪旁边点它开打 · 点领地复习领主`}
      </p>
    </div>
  );
}