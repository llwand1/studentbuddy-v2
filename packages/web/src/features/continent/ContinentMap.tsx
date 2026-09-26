/**
 * features/continent/ContinentMap — 知识大陆地图（canvas 像素渲染，照抄桌面 demo 的视觉）。
 *
 * 三点刻意为之（不是随手写的）：
 * 1. **地形与怪物分开画**：地块按「多久没碰」变暗加裂纹（时间可见），怪按题型序列点色点
 *    （一眼看出要打几道题、什么题）。两者都不含业务口径——谁有怪由 `continent-view.ts` 定。
 * 2. **两种过渡特效**（老板点单：拓开新区域/打怪要有过渡）：① 地块「长出来」`tile_pop`
 *    （缩放+淡入，按螺旋序错峰）；② 击杀后 `burst`（扩散环 + 爆散粒子）。
 *    特效时长刻意压在 1 秒内——地图是**常驻页**，动画长了会挡住下一次点击。
 * 3. **命中判定用 `getBoundingClientRect` 的尺寸比例**，不写死 48px：canvas 被 CSS 缩放
 *    （窄屏 `max-width:100%`）后，写死的坐标会把点击算到隔壁格。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CONTINENT_COLS, CONTINENT_QCOLOR, CONTINENT_ROWS } from '@sb/shared';
import type { ContinentTileView } from './continent-view';

/** 格子边长（逻辑像素；CSS 可再缩放） */
const CELL = 48;
/** 「长出来」动画时长与错峰步长 */
const POP_MS = 320;
const STAGGER_MS = 9;
const STAGGER_CAP = 60;
/** 击杀特效时长 */
const BURST_MS = 560;
const CANVAS_W = CONTINENT_COLS * CELL;
const CANVAS_H = CONTINENT_ROWS * CELL;

const COLOR = {
  bg: '#0a0a0f',
  grass: '#2f6b45',
  line: '#23252f',
  gold: '#f2c14e',
  body: '#6b4a7a',
  bodyLine: '#2a1c33',
  horn: '#e0c36b',
  sprout: '#7ee08f',
  crack: 'rgba(6,10,8,0.55)',
};

function drawTile(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number): void {
  const x = t.col * CELL;
  const y = t.row * CELL;
  const size = CELL * (0.7 + 0.3 * pop);
  const off = (CELL - size) / 2;
  // 草地：越久没碰越暗（时间看得见），但不至于黑到认不出
  ctx.globalAlpha = pop * (1 - Math.min(t.overdueDays / 14, 0.68));
  ctx.fillStyle = COLOR.grass;
  ctx.fillRect(x + off, y + off, size, size);
  ctx.globalAlpha = pop * 0.65;
  ctx.strokeStyle = COLOR.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + off + 1, y + off + 1, size - 2, size - 2);
  ctx.globalAlpha = 1;
  // 裂纹：逾期 3 天起出现（越久越裂）
  if (t.overdueDays >= 3 && pop > 0.9) {
    ctx.strokeStyle = COLOR.crack;
    ctx.lineWidth = 1.5;
    const cx = x + CELL / 2;
    const cy = y + CELL / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy - 8);
    ctx.lineTo(cx - 2, cy + 1);
    ctx.lineTo(cx - 7, cy + 9);
    ctx.stroke();
    if (t.overdueDays >= 7) {
      ctx.beginPath();
      ctx.moveTo(cx + 9, cy - 9);
      ctx.lineTo(cx + 3, cy + 2);
      ctx.stroke();
    }
  }
}

function drawSprout(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number): void {
  const cx = t.col * CELL + CELL / 2;
  const cy = t.row * CELL + CELL / 2;
  ctx.globalAlpha = pop * (t.discovered ? 1 : 0.42);
  ctx.fillStyle = t.discovered ? COLOR.sprout : '#6a7a72';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx + 4, cy);
  ctx.lineTo(cx, cy + 5);
  ctx.lineTo(cx - 4, cy);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** 怪：圆形身体 + 等级个角 + 题型色点序列（序列 = 每道题/每滴血） */
function drawMonster(ctx: CanvasRenderingContext2D, t: ContinentTileView, pop: number): void {
  const cx = t.col * CELL + CELL / 2;
  const cy = t.row * CELL + CELL / 2;
  const r = (9 + t.level * 4) * pop;
  if (r <= 0.5) return;
  ctx.globalAlpha = pop * 0.35;
  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.8, r * 0.85, r * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = pop;
  ctx.fillStyle = COLOR.body;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLOR.bodyLine;
  ctx.lineWidth = 2;
  ctx.stroke();
  // 角数 = 等级
  ctx.fillStyle = COLOR.horn;
  for (let i = 0; i < t.level; i += 1) {
    const span = r * 0.9;
    const hx = cx - span / 2 + (t.level === 1 ? span / 2 : (i * span) / (t.level - 1));
    ctx.beginPath();
    ctx.moveTo(hx - 3, cy - r * 0.82);
    ctx.lineTo(hx, cy - r * 1.45);
    ctx.lineTo(hx + 3, cy - r * 0.82);
    ctx.closePath();
    ctx.fill();
  }
  // 眼睛
  ctx.fillStyle = COLOR.bg;
  ctx.beginPath();
  ctx.arc(cx - r * 0.34, cy - r * 0.1, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.34, cy - r * 0.1, 2.2, 0, Math.PI * 2);
  ctx.fill();
  // 题型色点
  const step = 5.5;
  const startX = cx - ((t.species.length - 1) * step) / 2;
  t.species.forEach((s, i) => {
    ctx.fillStyle = CONTINENT_QCOLOR[s];
    ctx.beginPath();
    ctx.arc(startX + i * step, cy + r * 0.5, 2.4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

function drawFrame(ctx: CanvasRenderingContext2D, t: ContinentTileView, color: string, pop: number): void {
  ctx.globalAlpha = Math.max(pop, 0.9);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(t.col * CELL + 2, t.row * CELL + 2, CELL - 4, CELL - 4);
  ctx.globalAlpha = 1;
}

/** 击杀特效：扩散环 + 爆散粒子（420~760ms 量级，照 demo 的 `ring`/`burst`） */
function drawBurst(ctx: CanvasRenderingContext2D, t: ContinentTileView, age: number): void {
  const p = Math.min(age / BURST_MS, 1);
  const cx = t.col * CELL + CELL / 2;
  const cy = t.row * CELL + CELL / 2;
  ctx.globalAlpha = 1 - p;
  ctx.strokeStyle = COLOR.gold;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 8 + p * 26, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffe9a8';
  for (let i = 0; i < 8; i += 1) {
    const ang = (Math.PI * 2 * i) / 8;
    const d = 6 + p * 24;
    const rr = Math.max(2.6 * (1 - p), 0.2);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

interface Props {
  tiles: ContinentTileView[];
  onPick: (tile: ContinentTileView) => void;
  /** 击杀特效：父组件每次击杀换一个新对象（引用变 = 触发一次） */
  burst?: ContinentTileView | null;
  /** 外部高亮（答题弹窗打开时锁住那一格） */
  focus?: ContinentTileView | null;
}

export function ContinentMap({ tiles, onPick, burst = null, focus = null }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverRef = useRef<ContinentTileView | null>(null);
  const [hover, setHover] = useState<ContinentTileView | null>(null);
  const popRef = useRef({ key: '', start: 0 });
  const burstRef = useRef<{ start: number; tile: ContinentTileView } | null>(null);
  /** 地形变化的指纹：只有它变了才重放「长出来」（点一下弹窗不该让整张图重新长一遍） */
  const tilesKey = useMemo(
    () => tiles.map((t) => `${t.id}:${t.status}:${t.stage}:${t.hasMonster ? 1 : 0}`).join('|'),
    [tiles],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (popRef.current.key !== tilesKey) popRef.current = { key: tilesKey, start: performance.now() };
    if (burst) burstRef.current = { start: performance.now(), tile: burst };
    let raf = 0;
    const step = (): void => {
      const now = performance.now();
      const popAge = now - popRef.current.start;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = COLOR.bg;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      tiles.forEach((t, i) => {
        const delay = Math.min(i, STAGGER_CAP) * STAGGER_MS;
        const pop = Math.max(Math.min((popAge - delay) / POP_MS, 1), 0.001);
        drawTile(ctx, t, pop);
        if (t.hasMonster) drawMonster(ctx, t, pop);
        else drawSprout(ctx, t, pop);
      });
      const carried = burstRef.current;
      if (carried) {
        const age = now - carried.start;
        if (age < BURST_MS) drawBurst(ctx, carried.tile, age);
        else burstRef.current = null;
      }
      if (focus) drawFrame(ctx, focus, COLOR.gold, popAge);
      if (hoverRef.current) drawFrame(ctx, hoverRef.current, '#e8e9ee', popAge);
      const bAge = burstRef.current ? now - burstRef.current.start : Number.POSITIVE_INFINITY;
      if (popAge < STAGGER_CAP * STAGGER_MS + POP_MS + 40 || bAge < BURST_MS) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [tiles, tilesKey, hover, focus, burst]);

  /** 事件坐标 → 格子；用 rect 比例换算，CSS 缩放后也准 */
  const at = (canvas: HTMLCanvasElement, clientX: number, clientY: number): ContinentTileView | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const col = Math.floor(((clientX - rect.left) / rect.width) * CONTINENT_COLS);
    const row = Math.floor(((clientY - rect.top) / rect.height) * CONTINENT_ROWS);
    if (row < 0 || row >= CONTINENT_ROWS || col < 0 || col >= CONTINENT_COLS) return null;
    return tiles.find((t) => t.row === row && t.col === col) ?? null;
  };

  return (
    <div className="continent-map-wrap">
      <canvas
        ref={canvasRef}
        className="continent-map"
        width={CANVAS_W}
        height={CANVAS_H}
        aria-label="知识大陆地图"
        onMouseMove={(e) => {
          const t = at(e.currentTarget, e.clientX, e.clientY);
          hoverRef.current = t;
          if (t?.id !== hover?.id) setHover(t);
        }}
        onMouseLeave={() => {
          hoverRef.current = null;
          setHover(null);
        }}
        onClick={(e) => {
          const t = at(e.currentTarget, e.clientX, e.clientY);
          if (t) onPick(t);
        }}
      />
      <p className="continent-map-hint">
        {hover
          ? `${hover.term}（${hover.domain}）· ${hover.hasMonster ? `${hover.level} 级怪 · 点击复习解除占领` : '已收复 · 点击查看'}`
          : `共 ${tiles.length} 格 · 越靠中心入库越早 · 点地块查看，点怪复习`}
      </p>
    </div>
  );
}