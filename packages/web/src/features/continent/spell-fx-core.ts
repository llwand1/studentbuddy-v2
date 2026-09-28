/**
 * spell-fx-core — 魔法吟唱释放特效的像素引擎底座（契约 docs/SPELL-CHANT-SPEC.md §3.4）。
 *
 * ★ 画风纪律（与落地页 `hero-scene` 同源、参照 There Is No Light / Blasphemous 2 / Momodora / Deedlit 那一路手绘像素特效）：
 *   - **低清画布**：高 `FX_H` 个低清像素，宽按容器长宽比算，CSS `image-rendering: pixelated` 放大 ⇒ 边缘永远是硬方块；
 *   - **整数坐标 + 只用 `fillRect`**：圆、弧、线全部自己栅格化，不走 `arc()`/渐变/抗锯齿；
 *   - **定格节奏**：`FX_FPS` 帧/秒，帧与帧之间不插值——手绘逐帧动画的"顿"感来自这里；
 *   - **三档阶梯光斑**（`disc3`）代替径向渐变；命中帧用整屏**反白**（`invert`）+ 卡片震动，而不是模糊/泛光。
 * ★ 确定性：随机量只来自 `mulberry(seed)`（建场景时一次生成）与无状态 `hash(f, i)`（逐帧闪烁），
 *   `draw(ctx, ms)` 是时间的纯函数——同 seed 在任何机器上逐帧相同，测试拿假 ctx 录像就能断言。
 * ★ 本文件只有笔刷与目标（遗忘之影）的受击/消散；五款编排在 `spell-fx-gothic.ts` / `spell-fx-elements.ts`。
 */
import { WRAITH_MAP, WRAITH_PAL, drawSprite, type Palette, type SpriteMap } from '../../app/hero/hero-sprites';

/** 低清画布高度（像素）；宽度 = 高 × 容器长宽比，钳在 [FX_MIN_W, FX_MAX_W] */
export const FX_H = 120;
export const FX_MIN_W = 120;
export const FX_MAX_W = 260;
/** 定格帧率：15 帧/秒 ≈ 66.7ms 一帧（手绘特效常见的 12–15 帧） */
export const FX_FPS = 15;
export const FX_TICK_MS = 1000 / FX_FPS;
/** 目标精灵放大倍数（16×15 的遗忘之影 → 48×45 低清像素） */
export const TARGET_SCALE = 3;

export type Ctx = CanvasRenderingContext2D;

export interface FxFrame {
  ctx: Ctx;
  /** 定格后的时间（ms，`FX_TICK_MS` 的整数倍） */
  t: number;
  /** 帧序号 */
  f: number;
  w: number;
  h: number;
  /** 目标（怪）中心 */
  cx: number;
  cy: number;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
}

/** 固定种子伪随机（mulberry32）：同 seed 同序列 */
export function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** 无状态哈希 → [0,1)：给"这一帧这一粒要不要闪"用，帧间没有顺序依赖 */
export function hash(a: number, b = 0, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** 区间进度：t 在 [a, b] 里走到几成（越界钳 0/1） */
export const span = (t: number, a: number, b: number): number => clamp01((t - a) / Math.max(1, b - a));
/** 色阶：k∈[0,1] 取 colors 里对应的一格（阶梯，不插值——像素风不做渐变） */
export function ramp(colors: readonly string[], k: number): string {
  return colors[Math.min(colors.length - 1, Math.max(0, Math.floor(clamp01(k) * colors.length)))] ?? colors[0]!;
}

/* ── 笔刷（全部整数坐标、只用 fillRect） ─────────────────────────── */
export function px(c: Ctx, x: number, y: number, color: string, s = 1): void {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), s, s);
}

export function rect(c: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

/** 实心圆：逐行扫描的整数圆盘 */
export function disc(c: Ctx, cx: number, cy: number, r: number, color: string): void {
  const rr = Math.max(0, Math.round(r));
  c.fillStyle = color;
  for (let dy = -rr; dy <= rr; dy += 1) {
    const half = Math.floor(Math.sqrt(rr * rr - dy * dy));
    c.fillRect(Math.round(cx) - half, Math.round(cy) + dy, half * 2 + 1, 1);
  }
}

/** 三档阶梯光斑：外 / 中 / 芯（hero-scene 的"不用径向渐变"口径） */
export function disc3(c: Ctx, cx: number, cy: number, r: number, tiers: readonly [string, string, string]): void {
  disc(c, cx, cy, r, tiers[0]);
  disc(c, cx, cy, r * 0.66, tiers[1]);
  disc(c, cx, cy, r * 0.33, tiers[2]);
}

/** 线段：Bresenham + 方形笔刷 */
export function line(c: Ctx, x0: number, y0: number, x1: number, y1: number, color: string, thick = 1): void {
  let ax = Math.round(x0);
  let ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let err = dx + dy;
  const off = Math.floor(thick / 2);
  c.fillStyle = color;
  for (let guard = 0; guard < 4096; guard += 1) {
    c.fillRect(ax - off, ay - off, thick, thick);
    if (ax === bx && ay === by) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      ax += sx;
    }
    if (e2 <= dx) {
      err += dx;
      ay += sy;
    }
  }
}

/** 圆弧：按角度步进落点（弧度，顺时针为正；`sy` 压扁成椭圆） */
export function arc(c: Ctx, cx: number, cy: number, r: number, a0: number, a1: number, color: string, thick = 1, sy = 1): void {
  const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) * Math.max(1, r)));
  const off = Math.floor(thick / 2);
  c.fillStyle = color;
  for (let i = 0; i <= steps; i += 1) {
    const a = a0 + ((a1 - a0) * i) / steps;
    c.fillRect(Math.round(cx + Math.cos(a) * r) - off, Math.round(cy + Math.sin(a) * r * sy) - off, thick, thick);
  }
}

export function ring(c: Ctx, cx: number, cy: number, r: number, color: string, thick = 1, sy = 1): void {
  arc(c, cx, cy, r, 0, Math.PI * 2, color, thick, sy);
}

/**
 * 新月形斩击：边 / 缘 / 芯三层弧叠出一道粗刃，两端收尖、中段最厚（弯月形；There Is No Light 的白刃红边黑描）。
 * `thick` 为中段最大厚度。
 */
export function crescent(c: Ctx, cx: number, cy: number, r: number, a0: number, a1: number, core: string, rim: string, edge: string, thick = 7): void {
  const segs = 8;
  const layer = (color: string, base: number): void => {
    for (let i = 0; i < segs; i += 1) {
      const k = Math.sin((Math.PI * (i + 0.5)) / segs) ** 0.6;
      const th = Math.max(1, Math.round(base * k));
      const s0 = a0 + ((a1 - a0) * i) / segs;
      const s1 = a0 + ((a1 - a0) * (i + 1)) / segs;
      arc(c, cx, cy, r, s0, s1, color, th);
    }
  };
  layer(edge, thick);
  layer(rim, Math.max(1, thick - 2));
  layer(core, Math.max(1, thick - 5));
}

/** 命中后的放射速度线（Momodora / Deedlit 那种一两帧就没的"啪"）：由帧序号决定长短角度 */
export function impactLines(c: Ctx, cx: number, cy: number, f: number, color: string, n = 12, near = 12, far = 34): void {
  for (let i = 0; i < n; i += 1) {
    const a = (i * Math.PI * 2) / n + (hash(f, i) - 0.5) * 0.3;
    const r0 = near + hash(i, 5) * 6;
    const r1 = r0 + (far - near) * (0.5 + hash(i, 7, f) * 0.5);
    line(c, cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.8, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1 * 0.8, color, i % 2 ? 1 : 2);
  }
}

/** 四角星火：十字形的一粒闪（size 1 = 3×3，2 = 5×5） */
export function star(c: Ctx, x: number, y: number, color: string, size = 1): void {
  c.fillStyle = color;
  c.fillRect(Math.round(x) - size, Math.round(y), size * 2 + 1, 1);
  c.fillRect(Math.round(x), Math.round(y) - size, 1, size * 2 + 1);
}

/** 整屏闪光（alpha 只给整屏，不给单个像素——像素本身永远是实心色） */
export function flash(c: Ctx, w: number, h: number, color: string, alpha: number): void {
  c.globalAlpha = clamp01(alpha);
  c.fillStyle = color;
  c.fillRect(-10, -10, w + 20, h + 20);
  c.globalAlpha = 1;
}

/**
 * 命中帧的"负片"：已画的一切压成黑色剪影、其余铺成纸色——受击一帧的整屏反白
 * （Blasphemous / TINL 的惯用手法）。`paper` 用各款自己的最亮色，负片也带款式的调子。
 */
export function invert(c: Ctx, w: number, h: number, paper = '#ffffff'): void {
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = '#000000';
  c.fillRect(-10, -10, w + 20, h + 20);
  c.globalCompositeOperation = 'destination-over';
  c.fillStyle = paper;
  c.fillRect(-10, -10, w + 20, h + 20);
  c.globalCompositeOperation = 'source-over';
}

/** 这一帧是否**包含** `ms`（命中帧、闪光帧只出现一帧时用；与 DOM 侧 `setTimeout(ms)` 落在同一帧） */
export function atFrame(t: number, ms: number): boolean {
  return Math.floor(t / FX_TICK_MS) === Math.floor(ms / FX_TICK_MS);
}

/** 这一帧是否已到 `ms`（含包含 `ms` 的那一帧）：命中相关的阶段切换都用它，别用裸 `t >= ms` */
export function after(t: number, ms: number): boolean {
  return Math.floor(t / FX_TICK_MS) >= Math.floor(ms / FX_TICK_MS);
}

/** 黑幕：椭圆外的一切压黑，三档阶梯 + 逐行毛刺（hero-scene 的"黑暗吞没、挖洞留光"，TINL 味道） */
export function vignette(c: Ctx, w: number, h: number, cx: number, cy: number, r: number, f: number, color: string): void {
  const tiers: Array<[number, number]> = [
    [1.55, 0.85],
    [1.25, 0.6],
    [1, 0.4],
  ];
  c.fillStyle = color;
  for (const [mul, alpha] of tiers) {
    const R = Math.max(1, r * mul);
    c.globalAlpha = alpha;
    for (let y = -10; y < h + 10; y += 1) {
      const dy = (y - cy) / 0.72;
      const jag = hash(y, f >> 1, 4) * 3;
      const hw = dy * dy >= R * R ? -1 : Math.sqrt(R * R - dy * dy) + jag;
      if (hw < 0) {
        c.fillRect(-10, y, w + 20, 1);
        continue;
      }
      c.fillRect(-10, y, Math.round(cx - hw) + 10, 1);
      c.fillRect(Math.round(cx + hw), y, w - Math.round(cx + hw) + 10, 1);
    }
  }
  c.globalAlpha = 1;
}

/** 在透明画布上挖掉一个圆（新月 = 圆盘挖去一个错位圆） */
export function cutDisc(c: Ctx, cx: number, cy: number, r: number): void {
  c.globalCompositeOperation = 'destination-out';
  disc(c, cx, cy, r, '#000000');
  c.globalCompositeOperation = 'source-over';
}

/** 震屏偏移：帧序号驱动的整数抖动（同一帧永远同一偏移） */
export function shakeOffset(f: number, amp: number): [number, number] {
  if (amp <= 0) return [0, 0];
  return [Math.round((hash(f, 1) - 0.5) * 2 * amp), Math.round((hash(f, 2) - 0.5) * 2 * amp)];
}

/* ── 粒子：建场景时一次撒好，画时按 t 解析位置（无增量模拟 ⇒ 确定） ── */
export interface ScatterOpts {
  x: number;
  y: number;
  speed: [number, number];
  /** 出射角区间（弧度）；缺省全向 */
  angle?: [number, number];
  born: [number, number];
  life: [number, number];
  size?: number;
  /** 出生点抖动半径 */
  jitter?: number;
}

export function scatter(rng: () => number, n: number, o: ScatterOpts): Particle[] {
  const out: Particle[] = [];
  const [a0, a1] = o.angle ?? [0, Math.PI * 2];
  for (let i = 0; i < n; i += 1) {
    const a = a0 + (a1 - a0) * rng();
    const v = o.speed[0] + (o.speed[1] - o.speed[0]) * rng();
    const j = o.jitter ?? 0;
    out.push({
      x: o.x + (rng() - 0.5) * 2 * j,
      y: o.y + (rng() - 0.5) * 2 * j,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      born: o.born[0] + (o.born[1] - o.born[0]) * rng(),
      life: o.life[0] + (o.life[1] - o.life[0]) * rng(),
      size: o.size ?? 1,
    });
  }
  return out;
}

export interface PartPos {
  x: number;
  y: number;
  /** 寿命进度 0→1 */
  k: number;
}

/** 粒子在 t 时刻的位置；没出生或已死返回 null。`g` 为重力（px/s²），`drag` 为每秒速度衰减 */
export function partAt(p: Particle, t: number, g = 0, drag = 0): PartPos | null {
  const age = (t - p.born) / 1000;
  if (age < 0 || age * 1000 > p.life) return null;
  const d = drag > 0 ? (1 - Math.exp(-drag * age)) / drag : age;
  return { x: p.x + p.vx * d, y: p.y + p.vy * d + 0.5 * g * age * age, k: (age * 1000) / p.life };
}

/** 画一批粒子：颜色按寿命走色阶，尺寸随寿命从 size 缩到 1 */
export function drawParts(c: Ctx, parts: readonly Particle[], t: number, colors: readonly string[], g = 0, drag = 0): void {
  for (const p of parts) {
    const at = partAt(p, t, g, drag);
    if (!at) continue;
    const s = Math.max(1, Math.round(p.size * (1 - at.k * 0.6)));
    px(c, at.x, at.y, ramp(colors, at.k), s);
  }
}

/* ── 目标：遗忘之影（与地图上那只同一张字符画） ─────────────────── */
export interface TargetOpts {
  dx?: number;
  dy?: number;
  /** 受击白闪 */
  flash?: boolean;
  /** 下摆逐帧错位（常态的"飘"） */
  wobble?: boolean;
  alpha?: number;
}

export function targetBox(f: FxFrame): { x: number; y: number; w: number; h: number } {
  const w = 16 * TARGET_SCALE;
  const h = 15 * TARGET_SCALE;
  return { x: Math.round(f.cx - w / 2), y: Math.round(f.cy - h / 2), w, h };
}

export function drawTarget(f: FxFrame, o: TargetOpts = {}): void {
  const b = targetBox(f);
  const wob = o.wobble ? (row: number) => (row >= 12 ? ((f.f + row) % 3) - 1 : 0) : undefined;
  drawSprite(f.ctx, WRAITH_MAP, WRAITH_PAL, b.x + (o.dx ?? 0), b.y + (o.dy ?? 0), {
    scale: TARGET_SCALE,
    flip: true,
    flash: o.flash,
    alpha: o.alpha ?? 1,
    rowShift: wob,
  });
}

/** 消散方式：cut 斜切两半滑开 / rise 化金升天 / petal 化瓣飘散 / whirl 卷入旋风 / ash 成烬坠落 */
export type Dissolve = 'cut' | 'rise' | 'petal' | 'whirl' | 'ash';

/** 目标按 k∈[0,1] 消散：每个像素各走各的轨迹、各自按哈希决定何时熄灭，颜色沿 colors 色阶走 */
export function dissolveTarget(f: FxFrame, mode: Dissolve, k: number, colors: readonly string[]): void {
  if (k >= 1) return;
  const b = targetBox(f);
  const s = TARGET_SCALE;
  const wmax = Math.max(...WRAITH_MAP.map((r) => r.length));
  WRAITH_MAP.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx += 1) {
      const ch = row[rx]!;
      if (ch === '.' || ch === ' ') continue;
      const base = WRAITH_PAL[ch];
      if (!base) continue;
      const i = ry * 16 + rx;
      const r1 = hash(i, 11);
      const r2 = hash(i, 23);
      if (r1 < k * 1.25 - 0.25) continue;
      const gx = b.x + (wmax - 1 - rx) * s;
      const gy = b.y + ry * s;
      let dx = 0;
      let dy = 0;
      if (mode === 'cut') {
        const upper = wmax - 1 - rx - ry > 0;
        dx = (upper ? 1 : -1) * k * 16;
        dy = (upper ? -1 : 1) * k * 12 + k * k * 30;
      } else if (mode === 'rise') {
        dy = -k * (30 + r2 * 40);
        dx = Math.round(Math.sin(k * 6 + r1 * 6) * 2);
      } else if (mode === 'petal') {
        dx = (r2 - 0.5) * 2 * k * 44 + Math.sin(k * 8 + r1 * 6) * 3;
        dy = -k * 18 + k * k * 36;
      } else if (mode === 'whirl') {
        const a = r1 * Math.PI * 2 + k * 5;
        const rad = k * (26 + r2 * 30);
        dx = Math.cos(a) * rad;
        dy = Math.sin(a) * rad * 0.5 - k * 30;
      } else {
        dy = k * k * (50 + r2 * 40);
        dx = (r1 - 0.5) * 2 * k * 8;
      }
      const tint = k < 0.3 ? base : ramp(colors, (k - 0.3) / 0.7);
      px(f.ctx, gx + dx, gy + dy, tint, s);
    }
  });
}

/** 字符画精灵按整数坐标落地（薄封装：给叶子 / 羽毛 / 荆棘用） */
export function sprite(c: Ctx, map: SpriteMap, pal: Palette, x: number, y: number, scale = 1): void {
  drawSprite(c, map, pal, Math.round(x), Math.round(y), { scale });
}
