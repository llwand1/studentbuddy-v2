/**
 * spell-fx-gothic — 五款释放特效里的两款"哥特"编排（契约 docs/SPELL-CHANT-SPEC.md §3.4）：
 *
 * - **无光斩**（参照 There Is No Light）：黑幕从四边撕进来、暗处红眼明灭 → 一道白线定位 → 命中帧整屏负片、
 *   白刃红边黑描的弯月巨斩，第二刀交叉成十字，放射速度线 → 骨白碎片、黑血下坠，怪被斜切成两半滑开。
 * - **悔罪光柱**（参照 Blasphemous 2）：地面金尘上升、头顶光环与念珠旋转 → 天开一线、金色光柱轰下、地面金光溅开 →
 *   青铜荆棘从地里长出、蓝白奇迹之焰绕柱、金色星火明灭 → 怪化作金尘升天，光柱收窄熄灭。
 *
 * ★ 每个函数只在建场景时撒一次随机（rng），`draw(f)` 是帧的纯函数；时间全部写成毫秒常量，命中帧与
 *   shared 的 `SPELL_KIND_META.*.impactMs` 对齐（测试锁这一点）。
 */
import { FX_PAL, THORN_MAP } from './spell-fx-art';
import {
  atFrame,
  crescent,
  disc,
  dissolveTarget,
  drawParts,
  drawTarget,
  flash,
  hash,
  impactLines,
  invert,
  line,
  px,
  ramp,
  rect,
  ring,
  scatter,
  span,
  sprite,
  star,
  vignette,
  after,
  type FxFrame,
  type Particle,
} from './spell-fx-core';

export interface KindScene {
  draw: (f: FxFrame) => void;
  /** 该时刻的震屏幅度（低清像素） */
  shake: (t: number) => number;
  /** 本款编排里的命中毫秒——必须与 shared `SPELL_KIND_META[kind].impactMs` 相等（spell-fx.test 锁死） */
  impactMs: number;
}

export interface Stage {
  rng: () => number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/* ── 无光斩 ─────────────────────────────────────────────────────── */
const DUSK_HIT = 560;

export function duskScene(s: Stage): KindScene {
  const P = FX_PAL.dusk;
  const eyes = Array.from({ length: 14 }, () => ({ x: s.rng() * s.w, y: s.rng() * s.h, k: s.rng() }));
  const shards: Particle[] = scatter(s.rng, 20, { x: s.cx, y: s.cy, speed: [60, 170], born: [DUSK_HIT, DUSK_HIT + 40], life: [300, 540], size: 2 });
  const blood: Particle[] = scatter(s.rng, 28, {
    x: s.cx,
    y: s.cy,
    speed: [30, 120],
    angle: [-Math.PI * 0.95, -Math.PI * 0.05],
    born: [DUSK_HIT + 80, DUSK_HIT + 180],
    life: [700, 1000],
    size: 2,
    jitter: 8,
  });
  const slashRamp = [P.bone, P.bone, P.bright, P.red, P.blood, P.dusk];

  return {
    impactMs: DUSK_HIT,
    shake: (t) => (!after(t, DUSK_HIT) ? 0 : 5 * (1 - span(t, DUSK_HIT, 900))),
    draw: (f) => {
      const { ctx: c, t, w, h, cx, cy } = f;
      // 黑幕：椭圆外的世界被吞掉，只给怪留一个越缩越小的洞；命中后退去
      const dark = t < 900 ? span(t, 0, 480) : 1 - span(t, 900, 1500);
      if (dark > 0 && !atFrame(t, DUSK_HIT)) vignette(c, w, h, cx, cy, Math.max(w, h) * 0.9 - (Math.max(w, h) * 0.9 - 34) * dark, f.f, P.ink);
      // 暗处的红眼：只在黑幕期明灭
      if (t > 120 && t < 760) {
        eyes.forEach((e, i) => {
          const near = Math.abs(e.x - cx) < 30 && Math.abs(e.y - cy) < 26;
          if (near || hash(f.f >> 1, i) < 0.4) return;
          px(c, e.x, e.y, e.k > 0.5 ? P.bright : P.red, 1);
          px(c, e.x + 3, e.y, e.k > 0.5 ? P.bright : P.red, 1);
        });
      }
      // 墨点：命中后从怪身后炸开一团带毛刺的黑墨（TINL 的黑血）
      if (t >= DUSK_HIT + 67 && t < 1300) {
        const k = span(t, DUSK_HIT + 67, 1300);
        const r = 10 + 12 * Math.sqrt(k);
        disc(c, cx, cy + 2, r * (1 - k * 0.5), P.ink);
        for (let i = 0; i < 10; i += 1) {
          const a = (i * Math.PI * 2) / 10 + hash(i, 3) * 0.5;
          const len = r * (1 + hash(i, 4) * 0.8);
          line(c, cx, cy + 2, cx + Math.cos(a) * len, cy + 2 + Math.sin(a) * len * 0.7, P.ink, i % 3 ? 2 : 3);
        }
      }
      // 目标：常态 → 白闪（被推开）→ 斜切两半
      if (!after(t, DUSK_HIT)) drawTarget(f, { wobble: true });
      else if (!after(t, DUSK_HIT + 134)) drawTarget(f, { flash: true, dx: 3 });
      else dissolveTarget(f, 'cut', span(t, DUSK_HIT + 134, 1420), [P.red, P.blood, P.dusk, P.ink]);
      // 定位线：一道白线从左上划到右下
      if (t >= 400 && !after(t, DUSK_HIT)) {
        const k = span(t, 400, DUSK_HIT);
        line(c, cx - 46, cy - 40, cx - 46 + 92 * k, cy - 40 + 80 * k, P.bone, 1);
        if (f.f % 2 === 0) px(c, cx - 47, cy - 41, P.bright, 3);
      }
      // 第一刀：以左下为圆心的弯月巨斩，2 帧出完，之后沿色阶褪成残影
      if (after(t, DUSK_HIT) && t < 1100) {
        const k = span(t, DUSK_HIT, 1100);
        const reach = atFrame(t, DUSK_HIT) ? 0.62 : 1;
        const col = ramp(slashRamp, k);
        crescent(c, cx - 30, cy + 34, 64, -Math.PI * 0.62, -Math.PI * 0.62 + Math.PI * 0.66 * reach, col, k < 0.3 ? P.bright : col, P.ink, k < 0.5 ? 9 : 6);
      }
      // 第二刀：镜像交叉成十字
      if (t >= DUSK_HIT + 100 && t < 1250) {
        const k = span(t, DUSK_HIT + 100, 1250);
        const col = ramp(slashRamp, k);
        crescent(c, cx + 30, cy + 34, 64, -Math.PI * 0.38, -Math.PI * 0.38 - Math.PI * 0.66, col, k < 0.3 ? P.bright : col, P.ink, k < 0.5 ? 9 : 6);
      }
      if (t >= DUSK_HIT + 67 && t < DUSK_HIT + 200) impactLines(c, cx, cy, f.f, P.bone, 14, 14, 40);
      drawParts(c, shards, t, [P.bone, P.bone, P.bright, P.red], 120);
      drawParts(c, blood, t, [P.bright, P.red, P.blood, P.dusk], 260);
      // 命中帧：骨白纸上的黑剪影；下一帧血红一闪
      if (atFrame(t, DUSK_HIT)) invert(c, w, h, P.bone);
      else if (atFrame(t, DUSK_HIT + 67)) flash(c, w, h, P.red, 0.35);
    },
  };
}

/* ── 悔罪光柱 ────────────────────────────────────────────────────── */
const GRACE_HIT = 560;
const THORN_R = THORN_MAP;
const THORN_L = THORN_MAP.map((r) => [...r].reverse().join(''));
const THORN_PAL = { t: FX_PAL.grace.bronze, T: FX_PAL.grace.gold };
const THORN_X = [-44, -30, -16, 16, 30, 44];
const FLAME_X = [-12, -6, 0, 6, 12];

export function graceScene(s: Stage): KindScene {
  const P = FX_PAL.grace;
  const motes: Particle[] = Array.from({ length: 34 }, () => ({
    x: s.rng() * s.w,
    y: s.h + 2,
    vx: (s.rng() - 0.5) * 6,
    vy: -(12 + s.rng() * 18),
    born: s.rng() * 1300,
    life: 800 + s.rng() * 500,
    size: 1,
  }));
  const rays: Particle[] = scatter(s.rng, 14, { x: s.cx, y: s.cy + 8, speed: [90, 190], angle: [-Math.PI * 0.92, -Math.PI * 0.08], born: [GRACE_HIT, GRACE_HIT + 30], life: [260, 420], size: 2 });
  const thornH = THORN_X.map(() => 6 + Math.floor(s.rng() * 4));
  const stars = Array.from({ length: 9 }, () => ({ x: s.cx + (s.rng() - 0.5) * 90, y: s.rng() * (s.cy + 10), k: s.rng() }));

  return {
    impactMs: GRACE_HIT,
    shake: (t) => (!after(t, GRACE_HIT) ? 0 : 3 * (1 - span(t, GRACE_HIT, 820))),
    draw: (f) => {
      const { ctx: c, t, w, h, cx, cy } = f;
      drawParts(c, motes, t, [P.white, P.gold, P.amber, P.bronze]);
      // 光环 + 念珠
      if (t > 200 && t < 1600) {
        const hy = cy - 36;
        const fade = span(t, 1300, 1600);
        ring(c, cx, hy, 11, ramp([P.gold, P.gold, P.amber, P.bronze], fade), 1, 0.45);
        for (let i = 0; i < 8; i += 1) {
          const a = f.f * 0.22 + (i * Math.PI) / 4;
          if (hash(i, f.f) < fade) continue;
          px(c, cx + Math.cos(a) * 15, hy + Math.sin(a) * 15 * 0.45, i % 2 ? P.bronze : P.gold, 1);
        }
      }
      // 目标：常态 → 被光压得下沉白闪 → 化金升天
      if (!after(t, GRACE_HIT)) drawTarget(f, { wobble: true });
      else if (!after(t, GRACE_HIT + 134)) drawTarget(f, { flash: true, dy: 3 });
      else dissolveTarget(f, 'rise', span(t, GRACE_HIT + 134, 1460), [P.white, P.gold, P.amber, P.bronze]);
      // 天开一线
      if (t >= 480 && !after(t, GRACE_HIT)) line(c, cx, 0, cx, (cy - 20) * span(t, 480, GRACE_HIT), P.white, 1);
      // 斜射的天光：四道从画面上缘汇向柱基的暗金细线，逐帧明灭
      if (t >= 620 && t < 1100) {
        [-56, -30, 30, 56].forEach((ox, i) => {
          if (hash(f.f, i, 12) < 0.35) return;
          line(c, cx + ox, 0, cx + ox * 0.15, cy + 8, i % 2 ? P.bronze : P.amber, 1);
        });
      }
      // 光柱：三档阶梯、边缘逐帧毛刺
      const halfW = t < 700 ? 2 + 12 * span(t, GRACE_HIT, 700) : 14 * (1 - span(t, 940, 1300));
      if (after(t, GRACE_HIT) && halfW >= 1) {
        for (let y = 0; y <= cy + 6; y += 1) {
          const jag = hash(y, f.f) > 0.5 ? 1 : 0;
          rect(c, cx - halfW - jag, y, (halfW + jag) * 2 + 1, 1, P.amber);
          rect(c, cx - halfW * 0.62, y, halfW * 1.24 + 1, 1, P.gold);
          rect(c, cx - Math.max(0.5, halfW * 0.3), y, Math.max(1, halfW * 0.6), 1, P.white);
        }
      }
      // 地面金光向两侧溅开
      if (after(t, GRACE_HIT) && t < 820) {
        const k = span(t, GRACE_HIT, 820);
        const len = Math.round(k * w * 0.5);
        rect(c, cx - len, cy + 8, len * 2, k < 0.4 ? 2 : 1, ramp([P.white, P.gold, P.amber], k));
      }
      drawParts(c, rays, t, [P.white, P.gold, P.amber], 40);
      // 荆棘：从地里逐行长出，末段沉回去
      THORN_X.forEach((ox, i) => {
        const grow = span(t, 640 + i * 40, 900 + i * 40) - span(t, 1450, 1750);
        const n = Math.round(grow * thornH[i]!);
        if (n <= 0) return;
        const map = (ox < 0 ? THORN_L : THORN_R).slice(THORN_R.length - n);
        sprite(c, map, THORN_PAL, cx + ox - 5, cy + 12 - n * 2, 2);
      });
      // 蓝白奇迹之焰：绕柱基座，逐帧抖高
      if (t >= 700 && t < 1560) {
        const fade = span(t, 1300, 1560);
        FLAME_X.forEach((ox, i) => {
          if (hash(i, f.f, 5) < fade) return;
          const hh = 5 + Math.round(hash(f.f, i) * 4);
          const x = cx + ox;
          const base = cy + 12;
          rect(c, x - 2, base - Math.round(hh * 0.5), 5, Math.round(hh * 0.5), P.flame);
          rect(c, x - 1, base - Math.round(hh * 0.85), 3, Math.round(hh * 0.35), P.pale);
          rect(c, x, base - hh, 1, Math.max(1, hh - Math.round(hh * 0.85)), P.white);
          if (hash(f.f, i, 3) > 0.6) px(c, x + (hash(f.f, i, 4) - 0.5) * 6, base - hh - 2 - ((f.f * 3 + i * 5) % 10), P.pale, 1);
        });
      }
      // 金色星火：光柱周围明灭的四角星
      if (t >= 620 && t < 1400) stars.forEach((st, i) => hash(f.f >> 1, i, 8) > 0.55 && star(c, st.x, st.y, st.k > 0.5 ? P.gold : P.white, st.k > 0.8 ? 2 : 1));
      // 命中帧：金白纸上的黑剪影，下一帧金光一闪
      if (atFrame(t, GRACE_HIT)) invert(c, w, h, P.white);
      else if (atFrame(t, GRACE_HIT + 67)) flash(c, w, h, P.gold, 0.16);
      // 光柱熄灭后的余晖：地面一枚渐暗的光斑
      if (t >= 1300 && t < 1900) disc(c, cx, cy + 9, 3 * (1 - span(t, 1300, 1900)), P.amber);
    },
  };
}
