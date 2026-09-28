/**
 * features/continent/ContinentMap — 知识大陆地图（canvas 像素；交互在本文件、绘制在 `continent-*-draw.ts`）。
 *
 * 三层分工：① `continent-view.ts` 出结论（开拓了哪些格／迷雾边缘／野怪／建筑）；
 * ② `continent-terrain-draw.ts`、`continent-buildings-draw.ts`、`continent-canvas.ts` 只管画；
 * ③ 本文件＝**相机 + 命中 + 悬停 + 拖拽 + 点击上报 + 过渡动画的时间轴**。
 *
 * ★ 过渡（每一种变化都有，且都 ≤1 秒）：刚开拓的格迷雾从中心散开；新刷出的怪从空中落下淡入；
 *   地块升级有一道金光柱；建筑建成从地面升起；地貌交界是抖动渐变（静态，不耗帧）。
 * ★ 世界 ≠ 视口：背景铺底在 translate 之外；命中换算加相机偏移；只画视口内的格。
 * ★ 拖过就不算点击（`movedRef`）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONTINENT_VIEW_COLS, CONTINENT_VIEW_ROWS, cellKey } from '@sb/shared';
import { BURST_MS, CANVAS_H, CANVAS_W, CELL, COLOR, drawBackground, drawBurst, drawChest, drawEmber, drawFrame, drawHero, drawMonster, drawNpc } from './continent-canvas';
import { drawBiome, drawBiomeBlend, drawFog, drawFrontierMark, drawReveal, drawTileLevel } from './continent-terrain-draw';
import { drawBuilding } from './continent-buildings-draw';
import { camAfterDrag, useContinentCamera, type ContinentCam } from './useContinentCamera';
import { STEP_MS, type HeroCell } from './useContinentHero';
import { NO_SPOTS, cellHint, fogDistances, type ContinentCell, type ContinentChestDrop, type ContinentNpcMark, type ContinentTileView, type ContinentView } from './continent-view';

export type { ContinentCell, ContinentChestDrop, ContinentNpcMark };

/** 过渡时长 */
const REVEAL_MS = 700;
const SPAWN_MS = 600;
const RISE_MS = 900;
const GLOW_MS = 900;

interface Props {
  view: ContinentView;
  placeSpots?: readonly ContinentCell[];
  ember?: { row: number; col: number; hue: string } | null;
  hero: HeroCell | null;
  heroFrom: { row: number; col: number } | null;
  heroStart: number;
  chests: readonly ContinentChestDrop[];
  npcs: readonly ContinentNpcMark[];
  recenterTick: number;
  onPick: (row: number, col: number) => void;
  burst?: ContinentCell | null;
  focus?: ContinentCell | null;
  alert?: string | null;
  /** 刚开拓的格（引用变 = 播一次迷雾散开） */
  fresh?: readonly ContinentCell[] | null;
  /** 刚升级的格（引用变 = 播一次金光柱） */
  glow?: ContinentCell | null;
}

export function ContinentMap({
  view,
  placeSpots = NO_SPOTS,
  ember = null,
  hero,
  heroFrom,
  heroStart,
  chests,
  npcs,
  recenterTick,
  onPick,
  burst = null,
  focus = null,
  alert = null,
  fresh = null,
  glow = null,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverRef = useRef<ContinentCell | null>(null);
  const [hover, setHover] = useState<ContinentCell | null>(null);
  const [dragging, setDragging] = useState(false);
  const burstRef = useRef<{ start: number; cell: ContinentCell } | null>(null);
  const freshRef = useRef<{ start: number; keys: Set<string> }>({ start: 0, keys: new Set() });
  const glowRef = useRef<{ start: number; cell: ContinentCell } | null>(null);
  /** 首次出现时刻（怪 / 建筑）：用于落下与升起的过渡；首帧就在场的不播 */
  const seenRef = useRef<{ ready: boolean; at: Map<string, number> }>({ ready: false, at: new Map() });
  const { cam, setCam } = useContinentCamera(view.radius, hero, recenterTick);
  const camRef = useRef(cam);
  camRef.current = cam;
  const dragRef = useRef<{ x: number; y: number; cam: ContinentCam } | null>(null);
  const movedRef = useRef(false);

  const fog = useMemo(() => fogDistances(view.tiles, view.vision), [view.tiles, view.vision]);
  const tileAt = useMemo(() => new Map(view.tiles.map((t) => [cellKey(t.row, t.col), t])), [view.tiles]);
  const monAt = useMemo(() => new Set(view.monsters.map((m) => cellKey(m.row, m.col))), [view.monsters]);

  useEffect(() => {
    if (fresh && fresh.length) freshRef.current = { start: performance.now(), keys: new Set(fresh.map((c) => cellKey(c.row, c.col))) };
  }, [fresh]);
  useEffect(() => {
    if (glow) glowRef.current = { start: performance.now(), cell: glow };
  }, [glow]);
  useEffect(() => {
    if (burst) burstRef.current = { start: performance.now(), cell: burst };
  }, [burst]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const seen = seenRef.current;
    const t0 = performance.now();
    const ids = [...view.monsters.map((m) => m.id), ...view.buildings.map((b) => `b:${b.kind}:${b.anchor.row},${b.anchor.col}`)];
    for (const id of ids) if (!seen.at.has(id)) seen.at.set(id, seen.ready && !reduced ? t0 : 0);
    seen.ready = true;
    let raf = 0;
    const frame = (): void => {
      const now = reduced ? 0 : performance.now();
      const c = camRef.current;
      const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(now / 620);
      const inView = (row: number, col: number): boolean =>
        row >= c.row - 1 && row <= c.row + CONTINENT_VIEW_ROWS && col >= c.col - 1 && col <= c.col + CONTINENT_VIEW_COLS;
      drawBackground(ctx);
      ctx.save();
      ctx.translate(-c.col * CELL, -c.row * CELL);
      const fr = freshRef.current;
      const revealK = reduced ? 1 : Math.min((performance.now() - fr.start) / REVEAL_MS, 1);
      for (let row = c.row - 1; row <= c.row + CONTINENT_VIEW_ROWS; row += 1) {
        for (let col = c.col - 1; col <= c.col + CONTINENT_VIEW_COLS; col += 1) {
          const k = cellKey(row, col);
          const d = fog.get(k);
          if (d === undefined || d > view.vision) continue; // 迷雾深处：背景就是黑
          drawBiome(ctx, view.seed, row, col, now);
          drawBiomeBlend(ctx, view.seed, row, col, now);
          if (d > 0) {
            drawFog(ctx, row, col, d, view.vision);
            if (d === 1 && view.tokens > 0 && !monAt.has(k)) drawFrontierMark(ctx, row, col, pulse);
            continue;
          }
          const t = tileAt.get(k);
          const g = glowRef.current;
          const gk = g && g.cell.row === row && g.cell.col === col ? Math.max(1 - (performance.now() - g.start) / GLOW_MS, 0) : 0;
          if (t) drawTileLevel(ctx, row, col, t.lv, now, reduced ? 0 : gk);
          if (fr.keys.has(k)) drawReveal(ctx, row, col, revealK);
        }
      }
      for (const b of view.buildings) {
        const at = seen.at.get(`b:${b.kind}:${b.anchor.row},${b.anchor.col}`) ?? 0;
        const rise = at ? Math.min((performance.now() - at) / RISE_MS, 1) : 1;
        if (b.cells.some((x) => inView(x.row, x.col))) drawBuilding(ctx, b, now, rise);
      }
      const bob = reduced ? 0 : Math.round(Math.sin(now / 380) * 2);
      chests.forEach((d, i) => inView(d.row, d.col) && drawChest(ctx, d.row, d.col, bob + (i % 2)));
      const monsters: ContinentTileView[] = [...view.tiles.filter((t) => t.hasMonster), ...view.monsters];
      for (const m of monsters) {
        if (!inView(m.row, m.col)) continue;
        const at = seen.at.get(m.id) ?? 0;
        drawMonster(ctx, m, at ? Math.max(Math.min((performance.now() - at) / SPAWN_MS, 1), 0.02) : 1, now);
      }
      if (ember && inView(ember.row, ember.col)) drawEmber(ctx, ember, now);
      npcs.forEach((n, i) => {
        if (!inView(n.row, n.col)) return;
        drawNpc(ctx, n, reduced ? 0 : Math.round(Math.sin(now / 520) * 1.5) + (i % 2), n.distressed, pulse, n.job);
      });
      if (hero) drawHero(ctx, hero, heroFrom, reduced || !heroFrom ? 1 : Math.min((performance.now() - heroStart) / STEP_MS, 1));
      const bu = burstRef.current;
      if (bu) {
        const age = performance.now() - bu.start;
        if (age < BURST_MS && !reduced) drawBurst(ctx, bu.cell, age);
        else burstRef.current = null;
      }
      if (focus) drawFrame(ctx, focus, COLOR.gold, 1);
      if (hoverRef.current) drawFrame(ctx, hoverRef.current, COLOR.hover, 1);
      for (const s of placeSpots) if (inView(s.row, s.col)) drawFrame(ctx, s, COLOR.sprout, 1);
      ctx.restore();
      if (!reduced) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [view, fog, tileAt, monAt, hover, focus, hero, heroFrom, heroStart, chests, npcs, cam, placeSpots, ember]);

  const at = (canvas: HTMLCanvasElement, clientX: number, clientY: number): ContinentCell => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { row: cam.row, col: cam.col };
    const col = cam.col + Math.floor(((clientX - rect.left) / rect.width) * CONTINENT_VIEW_COLS);
    const row = cam.row + Math.floor(((clientY - rect.top) / rect.height) * CONTINENT_VIEW_ROWS);
    return { row, col };
  };

  const dragTo = (canvas: HTMLCanvasElement, x: number, y: number): void => {
    const d = dragRef.current;
    if (!d) return;
    const next = camAfterDrag(d, x, y, canvas.getBoundingClientRect(), view.radius);
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

  const hoverText = cellHint(hover, { ...view, npcs });

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
            return;
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
            movedRef.current = false;
            return;
          }
          const cell = at(e.currentTarget, e.clientX, e.clientY);
          onPick(cell.row, cell.col);
        }}
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
          (placeSpots !== NO_SPOTS ? `选位中：点一格把伙伴安置在那儿（绿框＝能站）${hoverText ? ` · ${hoverText}` : ''}` : hoverText) ??
          `已开拓 ${view.explored} 格 · 开拓令 ${view.tokens} 枚 · 拖拽看别处 · 方向键/WASD 或点地走位 · 站到迷雾边上点它开拓，点怪开打`}
      </p>
    </div>
  );
}
