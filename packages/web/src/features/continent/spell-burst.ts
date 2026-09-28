/**
 * spell-burst — 地图上的咒语版收复特效：五款各一套，与吟唱框里的释放特效同调色板、同笔刷（契约 SPELL-CHANT §3.4）。
 *
 * ★ 地图画布不是低清的（48px 一格、精灵按 `PX = 3` 放大），所以这里把坐标系 `scale(3)` 后按 16 单位/格作画，
 *   像素颗粒与地图上的怪、宝箱一样粗——特效不能比它打的怪还"高清"。
 * ★ 时长 `SPELL_BURST_MS` 压在 1 秒内（地图是常驻页，动画长了会挡住下一次点击，见 `continent-canvas.ts` 的 `BURST_MS`）。
 * ★ 与 `spell-fx-*` 一样是 (age) 的纯函数：随机量全部来自 `hash`，同一帧永远同一画面。
 */
import type { SpellKind } from '@sb/shared';
import { FEATHER_MAP, FX_PAL, LEAF_MAP, THORN_MAP, rotateMap } from './spell-fx-art';
import { arc, crescent, disc, disc3, hash, line, px, ramp, rect, ring, span, sprite, star, type Ctx } from './spell-fx-core';

/** 咒语版收复特效时长（ms） */
export const SPELL_BURST_MS = 900;
const TICK = 1000 / 15;
const LEAF_ROT = [0, 1, 2, 3].map((r) => rotateMap(LEAF_MAP, r));
const FEATHER_ROT = [0, 1, 2, 3].map((r) => rotateMap(FEATHER_MAP, r));
const FEATHER_PAL = { w: FX_PAL.sylph.white, W: FX_PAL.sylph.mint };
const THORN_PAL = { t: FX_PAL.grace.bronze, T: FX_PAL.grace.gold };

type Burst = (c: Ctx, t: number, f: number) => void;

/** 斜斩：三层同向线（墨边 → 红/亮 → 白芯）逐层缩短，像素刀口两头自然收尖 */
function slash(c: Ctx, x0: number, y0: number, x1: number, y1: number, core: string, rim: string, edge: string, reach: number): void {
  const ex = x0 + (x1 - x0) * reach;
  const ey = y0 + (y1 - y0) * reach;
  line(c, x0, y0, ex, ey, edge, 4);
  line(c, x0 + (ex - x0) * 0.08, y0 + (ey - y0) * 0.08, x0 + (ex - x0) * 0.92, y0 + (ey - y0) * 0.92, rim, 2);
  line(c, x0 + (ex - x0) * 0.2, y0 + (ey - y0) * 0.2, x0 + (ex - x0) * 0.8, y0 + (ey - y0) * 0.8, core, 1);
}

const dusk: Burst = (c, t, f) => {
  const P = FX_PAL.dusk;
  const k = span(t, 0, SPELL_BURST_MS);
  if (f === 0) rect(c, -8, -8, 16, 16, P.bone);
  if (t < 700) {
    const r = 3 + 5 * Math.sqrt(span(t, 60, 700));
    disc(c, 0, 1, r * (1 - span(t, 400, 700) * 0.6), P.ink);
    for (let i = 0; i < 6; i += 1) {
      const a = (i * Math.PI * 2) / 6 + hash(i, 3) * 0.6;
      line(c, 0, 1, Math.cos(a) * r * 1.6, 1 + Math.sin(a) * r * 1.1, P.ink, 1);
    }
  }
  // 两刀交叉：第一帧只出半刀，之后全长；550ms 起从两头往中心收、色阶转暗，820ms 收尽
  if (t < 820) {
    const rim = ramp([P.bright, P.bright, P.red, P.red, P.blood], k);
    const core = k < 0.45 ? P.bone : k < 0.65 ? P.bright : rim;
    const shrink = span(t, 550, 820) * 0.5;
    const L = 15 - 15 * shrink;
    const S = 11 - 11 * shrink;
    slash(c, -L, -S, L, S, core, rim, P.ink, f === 0 ? 0.55 : 1);
    if (t >= 100) slash(c, L, -S, -L, S, core, rim, P.ink, f === 1 ? 0.55 : 1);
  }
  for (let i = 0; i < 10; i += 1) {
    const born = 120 + hash(i, 1) * 120;
    const age = (t - born) / 1000;
    if (age < 0 || age > 0.62) continue;
    const a = -Math.PI * (0.1 + hash(i, 2) * 0.8);
    const v = 14 + hash(i, 4) * 26;
    px(c, Math.cos(a) * v * age, Math.sin(a) * v * age + 60 * age * age, ramp([P.bright, P.red, P.blood], span(t, born, SPELL_BURST_MS)), 1);
  }
};

const grace: Burst = (c, t, f) => {
  const P = FX_PAL.grace;
  const halfW = t < 260 ? 1 + 3 * span(t, 0, 260) : 4 * (1 - span(t, 500, 780));
  if (halfW >= 0.5) {
    for (let y = -40; y <= 4; y += 1) {
      const jag = hash(y, f) > 0.5 ? 1 : 0;
      rect(c, -halfW - jag, y, (halfW + jag) * 2 + 1, 1, P.amber);
      rect(c, -halfW * 0.6, y, halfW * 1.2 + 1, 1, P.gold);
      rect(c, -Math.max(0.5, halfW * 0.3), y, Math.max(1, halfW * 0.6), 1, P.white);
    }
  }
  if (t < 400) rect(c, -Math.round(span(t, 0, 400) * 20), 5, Math.round(span(t, 0, 400) * 40), 1, ramp([P.white, P.gold, P.amber], span(t, 0, 400)));
  if (t > 100 && t < 800) ring(c, 0, -14, 5, ramp([P.gold, P.gold, P.amber, P.bronze], span(t, 500, 800)), 1, 0.45);
  [-9, -5, 5, 9].forEach((ox, i) => {
    const n = Math.round((span(t, 220 + i * 60, 460 + i * 60) - span(t, 700, 900)) * 5);
    if (n <= 0) return;
    const map = THORN_MAP.slice(THORN_MAP.length - n).map((r) => r.slice(0, 5));
    sprite(c, ox < 0 ? map.map((r) => [...r].reverse().join('')) : map, THORN_PAL, ox - 2, 6 - n, 1);
  });
  if (t > 300 && t < 850) [-3, 0, 3].forEach((ox, i) => {
    const hh = 2 + Math.round(hash(f, i) * 2);
    rect(c, ox - 1, 6 - hh, 3, hh, P.flame);
    px(c, ox, 5 - hh, P.pale, 1);
  });
  for (let i = 0; i < 8; i += 1) {
    const born = hash(i, 6) * 500;
    const age = (t - born) / 1000;
    if (age < 0 || age > 0.7) continue;
    px(c, (hash(i, 7) - 0.5) * 24, 8 - age * 26, i % 2 ? P.gold : P.white, 1);
  }
  if (t > 250 && t < 800 && hash(f, 9) > 0.4) star(c, (hash(f, 10) - 0.5) * 22, (hash(f, 11) - 0.7) * 24, P.gold, 1);
};

const leaf: Burst = (c, t, f) => {
  const P = FX_PAL.leaf;
  const k = span(t, 0, SPELL_BURST_MS);
  if (f === 0) rect(c, -8, -8, 16, 16, P.pale);
  if (t < 600) ring(c, 0, 2, 3 + 18 * span(t, 0, 600), ramp([P.pale, P.teal, P.deep], span(t, 0, 600)), span(t, 0, 600) < 0.4 ? 2 : 1, 0.55);
  const pals = [
    { a: P.brown, b: P.pink, c: P.brown },
    { a: P.brown, b: P.coral, c: P.brown },
  ];
  for (let i = 0; i < 8; i += 1) {
    if (t > 600 && hash(i, f) < span(t, 600, SPELL_BURST_MS)) continue;
    const a = (i * Math.PI * 2) / 8 + hash(i, 2) * 0.5 + k * 1.4;
    const R = 3 + 19 * Math.sqrt(k);
    const drop = span(t, 400, SPELL_BURST_MS) ** 2 * 12;
    sprite(c, LEAF_ROT[(i + (f >> 1)) % 4]!, pals[i % 2]!, Math.cos(a) * R - 3, Math.sin(a) * R * 0.55 - 3 + drop, 1);
  }
  if (t < 820) for (let i = 0; i < 6; i += 1) if (hash(f, i, 3) > 0.5) star(c, (hash(i, 4) - 0.5) * 30, (hash(i, 5) - 0.5) * 24, i % 2 ? P.teal : P.pale, 1);
};

const sylph: Burst = (c, t, f) => {
  const P = FX_PAL.sylph;
  const grow = span(t, 0, 300);
  const gone = span(t, 560, 820);
  // 小龙卷：七层带缺口的细椭圆带，下窄上宽、缺口随时间转；先长高再一层层散掉
  for (let i = 0; i < 7; i += 1) {
    if (hash(i, f, 5) < gone) continue;
    const r = (2 + i * 1.9) * (0.4 + grow * 0.6 + gone * 1.3);
    const y = 7 - i * 3.6 * grow;
    const a0 = (t / 1000) * 9 + i * 0.9;
    const tone = (i + (f >> 1)) % 3;
    arc(c, 0, y, r, a0, a0 + Math.PI * 1.55, tone === 0 ? P.deep : tone === 1 ? P.green : P.mint, i === 0 ? 2 : 1, 0.4);
  }
  [
    { at: 60, a0: -2.6 },
    { at: 200, a0: -0.4 },
    { at: 340, a0: 1.8 },
  ].forEach((b) => {
    if (t < b.at || t >= b.at + 200) return;
    crescent(c, 0, -4, 13, b.a0, b.a0 + 1.7, span(t, b.at, b.at + 200) < 0.5 ? P.white : P.mint, P.mint, P.deep, 3);
  });
  for (let i = 0; i < 6; i += 1) {
    const born = 240 + hash(i, 6) * 180;
    const age = (t - born) / 1000;
    if (age < 0 || age > 0.45) continue;
    const a = -Math.PI * (0.15 + hash(i, 7) * 0.7);
    sprite(c, FEATHER_ROT[(i + (f >> 1)) % 4]!, FEATHER_PAL, Math.cos(a) * 30 * age - 2, -4 + Math.sin(a) * 26 * age + 30 * age * age, 1);
  }
  for (let i = 0; i < 6; i += 1) {
    const x = ((hash(i, 8) * 60 + t * 0.09 * (1 + hash(i, 9))) % 60) - 30;
    if (t < 700) rect(c, x, (hash(i, 10) - 0.5) * 20, 3 + hash(i, 11) * 3, 1, i % 2 ? P.gust : P.mint);
  }
  if (f >= 1 && f <= 3) for (let i = 0; i < 8; i += 1) {
    const a = (i * Math.PI * 2) / 8 + hash(f, i) * 0.3;
    line(c, Math.cos(a) * 5, Math.sin(a) * 4, Math.cos(a) * (9 + hash(i, 12, f) * 5), Math.sin(a) * (7 + hash(i, 13, f) * 4), P.white, 1);
  }
};

const salamander: Burst = (c, t, f) => {
  const P = FX_PAL.salamander;
  if (f === 0) rect(c, -8, -8, 16, 16, P.yellow);
  if (t >= 500) for (let dy = -1; dy <= 1; dy += 1) if (hash(dy, f, 7) > span(t, 700, SPELL_BURST_MS)) rect(c, -6 + Math.abs(dy) * 2, 6 + dy, 12 - Math.abs(dy) * 4, 1, P.dark);
  if (t < 320) disc3(c, 0, 0, 2 + 7 * span(t, 0, 200), [P.red, P.orange, P.yellow]);
  else if (t < 500) ring(c, 0, 0, 9 + 3 * span(t, 320, 500), ramp([P.orange, P.red, P.ember], span(t, 320, 500)), 2);
  if (t >= 120 && t < 760) {
    const k = span(t, 120, 760);
    const r = 2 + 18 * k;
    arc(c, 0, 4, r, 0, Math.PI * 2, ramp([P.yellow, P.orange, P.red, P.ember], k), 2, 0.5);
    for (let i = 0; i <= 7; i += 1) {
      const a = -Math.PI + (i * Math.PI) / 7;
      const hh = 1 + Math.round(hash(f, i) * 2);
      rect(c, Math.cos(a) * r, 4 + Math.sin(a) * r * 0.5 - hh, 1, hh, P.orange);
    }
  }
  for (let i = 0; i < 14; i += 1) {
    const born = 60 + hash(i, 1) * 60;
    const age = (t - born) / 1000;
    if (age < 0 || age > 0.7) continue;
    const a = -Math.PI * hash(i, 2);
    const v = 16 + hash(i, 3) * 30;
    px(c, Math.cos(a) * v * age, Math.sin(a) * v * age + 40 * age * age, ramp([P.yellow, P.orange, P.red, P.ember, P.dark], age / 0.7), age < 0.3 ? 2 : 1);
  }
  for (let i = 0; i < 3; i += 1) {
    const age = (t - 280 - i * 90) / 1000;
    if (age < 0 || age > 0.4) continue;
    c.globalAlpha = age < 0.2 ? 0.6 : 0.3;
    disc(c, (hash(i, 5) - 0.5) * 8 + Math.sin(age * 8) * 2, -2 - age * 34, 1 + 4 * age, P.smoke);
    c.globalAlpha = 1;
  }
  if (f >= 1 && f <= 3) for (let i = 0; i < 10; i += 1) {
    const a = (i * Math.PI * 2) / 10 + hash(f, i) * 0.3;
    line(c, Math.cos(a) * 6, Math.sin(a) * 5, Math.cos(a) * (10 + hash(i, 12, f) * 6), Math.sin(a) * (8 + hash(i, 13, f) * 5), P.yellow, 1);
  }
};

const BURSTS: Record<SpellKind, Burst> = { dusk, grace, leaf, sylph, salamander };

/** 在地图坐标 (cx, cy)（格中心，CSS 像素）画 `age` 毫秒时刻的咒语版收复特效 */
export function drawSpellBurst(ctx: Ctx, cx: number, cy: number, age: number, kind: SpellKind): void {
  const f = Math.floor(age / TICK);
  const t = (f + 0.5) * TICK;
  ctx.save();
  ctx.translate(Math.round(cx), Math.round(cy));
  ctx.scale(3, 3);
  BURSTS[kind](ctx, t, f);
  ctx.restore();
  ctx.globalAlpha = 1;
}
