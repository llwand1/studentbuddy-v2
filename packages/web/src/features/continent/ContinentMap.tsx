/**
 * features/continent/ContinentMap — 知识大陆地图（canvas 像素；交互在本文件、绘制在 `continent-canvas.ts`）。
 *
 * 三层分工：① `continent-view.ts` 出结论（谁有怪／谁的领地／哪格能站／世界多大）；
 * ② `continent-canvas.ts` 只管"给定状态画什么"；③ 本文件＝**相机 + 命中 + 悬停 + 拖拽 + 点击上报**。
 *
 * ★★ 2026-09-27（开放世界批）起**世界 ≠ 视口**：世界是以 `(0,0)` 为中心、半径 `radius` 的有符号网格，
 *   视口只有 `CONTINENT_VIEW_COLS × ROWS`。于是本文件多了三件必须一起做的事（缺一件就出静默死路）：
 *   ① 绘制前 `translate(-cam)`，且**背景铺底放在 translate 之外**（世界有负坐标，否则一拖就露缝）；
 *   ② 命中换算**加上相机偏移**（漏了就是"点到的格 ≠ 画出来的格"）；
 *   ③ **只画视口内的格**（世界 225 格起，全量逐格绘 + 全量"长出来"动画是白跑）。
 *   相机的规则（夹取／最小可见跟随／回英雄／拖拽换算）整体在 `useContinentCamera.ts`。
 *
 * ★ 命中判定走 `getBoundingClientRect` 的比例，**不写死 48px**：canvas 被 CSS 缩放后写死会算到隔壁格。
 * ★ 命中只上报**格子坐标**：领地可能落在没铺词条的荒地上（`view.wildLands`），报坐标两种格都接得住。
 * ★ **拖过就不算点击**（`movedRef`）：否则"想看看远处"会顺手点开一个弹窗。
 *   ⚠️ `click` 晚于 `mouseup`，故**不能**读 `dragRef`（那时已置空）——必须单独记一笔。
 * ★ 抽帧：只在「地形指纹变了 / 有击杀特效 / 英雄在走」时开 rAF，静止不开循环；重放"长出来"只认地形指纹。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONTINENT_VIEW_COLS, CONTINENT_VIEW_ROWS, worldCells } from '@sb/shared';
import {
  BURST_MS,
  CANVAS_H,
  CANVAS_W,
  CELL,
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
  drawNpc,
  drawSprout,
  drawTile,
} from './continent-canvas';
import { camAfterDrag, useContinentCamera, type ContinentCam } from './useContinentCamera';
import { STEP_MS, type HeroCell } from './useContinentHero';
import {
  NO_SPOTS,
  cellHint,
  type ContinentCell,
  type ContinentChestDrop,
  type ContinentLandCell,
  type ContinentNpcMark,
  type ContinentTileView,
} from './continent-view';

// ★ 地图的三个视图形状（宝箱 / 格子 / 伙伴标记）搬去了 `continent-view.ts`（与 `ContinentTileView` 同族，
//   那里本来就是"地图的视图形状"的家）。批 12 加选位态时本文件 `.tsx ≤300` 已贴线，搬走腾出的行数正好用上。
//   这里**原样再导出**一次：调用方（`ContinentPage` / `continent-partners`）的 import 一行未改。
export type { ContinentCell, ContinentChestDrop, ContinentNpcMark };

interface Props {
  tiles: ContinentTileView[];
  /** 荒地上的领地格（`tiles` 装不下的那些）——不画它们，一整片占领区就看不见 */
  wildLands: readonly ContinentLandCell[];
  /** 世界半径（`continent-view` 给；相机夹取与"大陆多大"都用它） */
  radius: number;
  /**
   * 选位态的可落位格（**给了就是选位态**）：每一格画一个绿框，提示行也改口径。
   * ★ 内容由服务端给（`GET /api/npc` 的 `spots`）：前端不重算铺格/领地，自己算就是第二份口径。
   */
  placeSpots?: readonly ContinentCell[];
  hero: HeroCell | null;
  heroFrom: { row: number; col: number } | null;
  /** 这一步的起始时刻（`performance.now()`），插值用 */
  heroStart: number;
  chests: readonly ContinentChestDrop[];
  /** 大陆上的学习伙伴（含遇险标记；结论由服务端给） */
  npcs: readonly ContinentNpcMark[];
  /** 「回到我身上」的计数（页面自增一次 = 按了一次） */
  recenterToken: number;
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
  radius,
  placeSpots = NO_SPOTS,
  hero,
  heroFrom,
  heroStart,
  chests,
  npcs,
  recenterToken,
  onPick,
  burst = null,
  focus = null,
  alert = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverRef = useRef<ContinentCell | null>(null);
  const [hover, setHover] = useState<ContinentCell | null>(null);
  const [dragging, setDragging] = useState(false);
  const popRef = useRef({ key: '', start: 0 });
  const burstRef = useRef<{ start: number; tile: ContinentTileView } | null>(null);
  const { cam, setCam } = useContinentCamera(radius, hero, recenterToken);
  const camRef = useRef(cam);
  camRef.current = cam;
  /** 拖拽起点快照（起点像素 + 起点相机） */
  const dragRef = useRef<{ x: number; y: number; cam: ContinentCam } | null>(null);
  /** 这次拖拽真的移动过（click 晚于 mouseup ⇒ 不能读 `dragRef`，它是空的了） */
  const movedRef = useRef(false);

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
      const c = camRef.current;
      const popAge = reducedMotion ? Number.POSITIVE_INFINITY : now - popRef.current.start;
      const pulse = reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(now / 620);
      const popAt = (delay: number): number =>
        Math.max(Math.min((popAge - Math.min(delay, STAGGER_CAP * STAGGER_MS)) / POP_MS, 1), 0.001);
      const popOf = (i: number): number => popAt(i * STAGGER_MS);
      /** 视口内的格（±1 格余量：边缘那格的"长出来"缩放与怪角会溢出到界外） */
      const shown = (row: number, col: number): boolean =>
        row >= c.row - 1 &&
        row <= c.row + CONTINENT_VIEW_ROWS &&
        col >= c.col - 1 &&
        col <= c.col + CONTINENT_VIEW_COLS;

      drawBackground(ctx); // ★ 在 translate 之外：世界有负坐标，铺在里面会留缝
      ctx.save();
      ctx.translate(-c.col * CELL, -c.row * CELL);
      tiles.forEach((t, i) => {
        if (!shown(t.row, t.col)) return;
        const pop = popOf(i);
        drawTile(ctx, t, pop);
        if (t.isLand) drawLand(ctx, t, pop, pulse);
        else if (!t.hasMonster) drawSprout(ctx, t, pop);
      });
      // 荒地上的领地：地块本身没铺词条（也就没有 tile），但仍要被占领、要挡路、要能点
      const wildPop = popAt(tiles.length * STAGGER_MS);
      for (const l of wildLands) if (shown(l.row, l.col)) drawLand(ctx, l, wildPop, pulse);
      // 宝箱画在怪下面：它是"地上的东西"，不该盖住怪的脸
      const bob = reducedMotion ? 0 : Math.round(Math.sin(now / 380) * 2);
      chests.forEach((d, i) => {
        if (shown(d.row, d.col)) drawChest(ctx, d.row, d.col, bob + (i % 2));
      });
      tiles.forEach((t, i) => {
        if (t.hasMonster && shown(t.row, t.col)) drawMonster(ctx, t, popOf(i));
      });
      // ★ 伙伴画在**怪之上**（"他在怪的地盘上"要看得见）、**英雄之下**（玩家自己的角色永不被遮）
      npcs.forEach((n, i) => {
        if (!shown(n.row, n.col)) return;
        const idle = reducedMotion ? 0 : Math.round(Math.sin(now / 520) * 1.5) + (i % 2);
        drawNpc(ctx, n, idle, n.distressed, reducedMotion ? 1 : pulse);
      });
      if (hero) {
        const k = reducedMotion || !heroFrom ? 1 : Math.min((now - heroStart) / STEP_MS, 1);
        drawHero(ctx, hero, heroFrom, k);
      }
      const carried = burstRef.current;
      if (carried) {
        const age = now - carried.start;
        if (age < BURST_MS) drawBurst(ctx, carried.tile, age);
        else burstRef.current = null;
      }
      if (focus) drawFrame(ctx, focus, COLOR.gold, popAge);
      if (hoverRef.current) drawFrame(ctx, hoverRef.current, COLOR.hover, popAge);
      // ★ 选位态：把**能站的格**逐格标出来（绿框，与悬停的白框、锁定的金框都不同色）。
      //   这一笔是"玩家自己点格子放"唯一需要的新绘制——落在哪、哪不能落，一眼看得出来。
      for (const s of placeSpots) if (shown(s.row, s.col)) drawFrame(ctx, s, COLOR.sprout, 1);
      ctx.restore();

      const bAge = burstRef.current ? now - burstRef.current.start : Number.POSITIVE_INFINITY;
      if (popAge < STAGGER_CAP * STAGGER_MS + POP_MS + 40 || bAge < BURST_MS || now - heroStart < STEP_MS + 60) {
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [tiles, wildLands, tilesKey, hover, focus, burst, hero, heroFrom, heroStart, chests, npcs, cam, placeSpots]);

  /** 事件坐标 → **世界格**：视口比例换算 + 相机偏移（CSS 缩放后也准） */
  const at = (canvas: HTMLCanvasElement, clientX: number, clientY: number): ContinentCell => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { row: cam.row, col: cam.col };
    const col = cam.col + Math.floor(((clientX - rect.left) / rect.width) * CONTINENT_VIEW_COLS);
    const row = cam.row + Math.floor(((clientY - rect.top) / rect.height) * CONTINENT_VIEW_ROWS);
    return { row, col };
  };

  /** 拖拽：纯换算在 `camAfterDrag`（可单测）；`moved` 决定这一下算拖拽还是点击 */
  const dragTo = (canvas: HTMLCanvasElement, x: number, y: number): void => {
    const d = dragRef.current;
    if (!d) return;
    const next = camAfterDrag(d, x, y, canvas.getBoundingClientRect(), radius);
    if (!next) return;
    movedRef.current = true;
    setCam(next);
  };

  const beginDrag = (x: number, y: number): void => {
    movedRef.current = false;
    dragRef.current = { x, y, cam };
    setDragging(true);
  };
  const endDrag = (): void => {
    dragRef.current = null;
    setDragging(false);
  };

  const hoverText = cellHint(hover, { tiles, wildLands, npcs });
  const size = 2 * radius + 1;
  const inView = tiles.filter(
    (t) =>
      t.row >= cam.row &&
      t.row < cam.row + CONTINENT_VIEW_ROWS &&
      t.col >= cam.col &&
      t.col < cam.col + CONTINENT_VIEW_COLS,
  ).length;

  return (
    <div className="continent-map-wrap">
      <canvas
        ref={canvasRef}
        className={dragging ? 'continent-map dragging' : 'continent-map'}
        width={CANVAS_W}
        height={CANVAS_H}
        aria-label="知识大陆地图"
        onMouseDown={(e) => beginDrag(e.clientX, e.clientY)}
        onMouseMove={(e) => {
          if (dragRef.current) {
            dragTo(e.currentTarget, e.clientX, e.clientY);
            return; // 拖拽中不算悬停（否则镜头上移时高亮框会乱跳）
          }
          const cell = at(e.currentTarget, e.clientX, e.clientY);
          hoverRef.current = cell;
          if (cell.row !== hover?.row || cell.col !== hover?.col) setHover(cell);
        }}
        onMouseUp={endDrag}
        onMouseLeave={() => {
          endDrag();
          hoverRef.current = null;
          setHover(null);
        }}
        onClick={(e) => {
          if (movedRef.current) {
            movedRef.current = false; // ★ 拖过就不算点击，且只吞这一次
            return;
          }
          const cell = at(e.currentTarget, e.clientX, e.clientY);
          onPick(cell.row, cell.col);
        }}
        // 触屏同样能拖（窄屏也开着地图；`touch-action` 在 CSS 里已设 none）
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (t) beginDrag(t.clientX, t.clientY);
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          if (t) dragTo(e.currentTarget, t.clientX, t.clientY);
        }}
        onTouchEnd={endDrag}
      />
      <p className={alert ? 'continent-map-hint warn' : 'continent-map-hint'}>
        {alert ??
          (placeSpots !== NO_SPOTS
            ? `选位中：点一格把伙伴安置在那儿（绿框＝能站）${hoverText ? ` · ${hoverText}` : ''}`
            : hoverText) ??
          `大陆 ${size}×${size} 格（共 ${worldCells(radius)} 格，视野内 ${inView} 格）· 拖拽看别处 · 方向键/WASD 或点地走位 · 走到怪旁边点它开打${
            npcs.length > 0 ? ' · 点伙伴跟他说句话' : ''
          }`}
      </p>
    </div>
  );
}