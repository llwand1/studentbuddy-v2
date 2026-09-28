/**
 * spell-fx-elements — 五款释放特效里的三款"自然元素"编排（契约 docs/SPELL-CHANT-SPEC.md §3.4）：
 *
 * - **月下叶舞**（参照 Momodora: Moonlit Farewell）：新月在右上角亮起、十四片枫叶绕怪螺旋收拢、薄荷绿星火明灭 →
 *   命中帧粉白一闪、花形印记绽开、青色椭圆环荡出 → 枫叶炸开成环、边转边落、摇摆着飘下，怪化作花瓣散去。
 * - **风灵旋刃**（参照 Deedlit 的风精灵 Sylph）：横向风痕越刮越密、三条螺旋臂卷成龙卷把怪托起 →
 *   三道薄荷白芯的风刃依次穿过 → 旋风松开、羽毛摇摆落下，怪被卷进风里散掉。
 * - **炎蛇**（参照 Deedlit 的火精灵 Salamander）：火蛇从左侧蜿蜒窜出、绕怪盘三匝越缠越紧、身后拖余烬 →
 *   一口咬下：负片、火球胀成空环、地面火环外扩、顶缘火舌乱跳、余烬四射 → 烟团上升，地上留一枚渐淡的焦痕。
 */
import { BLOOM_MAP, FEATHER_MAP, FX_PAL, LEAF_MAP, rotateMap } from './spell-fx-art';
import {
  atFrame,
  crescent,
  cutDisc,
  disc,
  disc3,
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
  after,
  type Particle,
} from './spell-fx-core';
import type { KindScene, Stage } from './spell-fx-gothic';

const LEAF_ROT = [0, 1, 2, 3].map((r) => rotateMap(LEAF_MAP, r));
const FEATHER_ROT = [0, 1, 2, 3].map((r) => rotateMap(FEATHER_MAP, r));

/* ── 月下叶舞 ────────────────────────────────────────────────────── */
const LEAF_HIT = 640;

export function leafScene(s: Stage): KindScene {
  const P = FX_PAL.leaf;
  const pals = [
    { a: P.brown, b: P.pink, c: P.brown },
    { a: P.brown, b: P.coral, c: P.brown },
    { a: P.pink, b: P.pale, c: P.brown },
  ];
  const leaves = Array.from({ length: 14 }, (_, i) => ({
    a0: (i * Math.PI * 2) / 14 + s.rng() * 0.4,
    pal: pals[i % 3]!,
    rot: Math.floor(s.rng() * 4),
    sway: s.rng() * 6,
    fall: 0.7 + s.rng() * 0.6,
    /** 六片大叶在前、八片小叶在后——两档尺寸给出前后景 */
    size: i % 5 === 0 || i % 7 === 0 ? 2 : 1,
  }));
  const hitStars = Array.from({ length: 10 }, () => ({ x: s.cx + (s.rng() - 0.5) * 80, y: s.cy + (s.rng() - 0.5) * 60, k: s.rng() }));
  const twinkles = Array.from({ length: 22 }, () => ({ x: s.cx + (s.rng() - 0.5) * 100, y: s.cy + (s.rng() - 0.5) * 70 }));
  const moonStars = Array.from({ length: 5 }, () => ({ x: s.w - 30 + (s.rng() - 0.5) * 40, y: 24 + (s.rng() - 0.5) * 30 }));
  const petals: Particle[] = scatter(s.rng, 18, { x: s.cx, y: s.cy, speed: [40, 120], born: [LEAF_HIT, LEAF_HIT + 60], life: [500, 900], size: 2 });

  return {
    impactMs: LEAF_HIT,
    shake: (t) => (!after(t, LEAF_HIT) ? 0 : 3 * (1 - span(t, LEAF_HIT, 900))),
    draw: (f) => {
      const { ctx: c, t, w, h, cx, cy } = f;
      // 新月：右上角亮起，末段收回
      const moonR = Math.round(12 * (t < 1300 ? span(t, 100, 450) : 1 - span(t, 1300, 1800)));
      if (moonR > 0) {
        disc(c, w - 30, 24, moonR, P.moon);
        cutDisc(c, w - 25, 21, moonR - 1);
        moonStars.forEach((m, i) => hash(f.f >> 1, i) > 0.5 && px(c, m.x, m.y, P.pale, 1));
      }
      // 星火：绕怪明灭
      if (t > 100 && t < 1500) twinkles.forEach((p, i) => hash(f.f, i) > 0.62 && px(c, p.x, p.y, i % 2 ? P.teal : P.pale, 1));
      // 目标：常态 → 被托起白闪 → 化瓣飘散
      if (!after(t, LEAF_HIT)) drawTarget(f, { wobble: true });
      else if (!after(t, LEAF_HIT + 134)) drawTarget(f, { flash: true, dy: -3 });
      else dissolveTarget(f, 'petal', span(t, LEAF_HIT + 134, 1500), [P.pale, P.pink, P.coral, P.brown]);
      // 印记：花形徽记先粉后白，胀大三帧再褪
      if (after(t, LEAF_HIT) && t < 920) {
        const k = span(t, LEAF_HIT, 920);
        const sc = 3 + Math.min(2, Math.floor((t - LEAF_HIT) / 67));
        const pal = { x: ramp([P.pink, P.pink, P.coral, P.brown], k) };
        sprite(c, BLOOM_MAP, pal, cx - 4.5 * sc, cy - 4.5 * sc, sc);
        if (k < 0.5) sprite(c, BLOOM_MAP, { x: P.pale }, cx - 4.5 * (sc - 1), cy - 4.5 * (sc - 1), sc - 1);
      }
      // 青色椭圆环荡出
      if (after(t, LEAF_HIT) && t < 1000) {
        const k = span(t, LEAF_HIT, 1000);
        ring(c, cx, cy + 6, 6 + 44 * k, ramp([P.pale, P.teal, P.teal, P.deep], k), k < 0.4 ? 2 : 1, 0.55);
      }
      drawParts(c, petals, t, [P.pale, P.pink, P.coral, P.brown], 60);
      // 枫叶：螺旋收拢 → 炸开成环 → 摇摆飘落
      leaves.forEach((L, i) => {
        if (t >= 1400 && hash(i, f.f) < span(t, 1400, 1800)) return;
        let ang: number;
        let R: number;
        let drop = 0;
        if (!after(t, LEAF_HIT)) {
          const k = span(t, 0, LEAF_HIT);
          ang = L.a0 + (t / 1000) * 5.5;
          R = 50 - 42 * k * k;
        } else {
          const k = span(t, LEAF_HIT, 1100);
          ang = L.a0 + 3.52 + span(t, LEAF_HIT, 1800) * 1.6;
          R = 8 + 62 * Math.sqrt(k);
          const fk = span(t, 900, 1800);
          drop = fk * fk * 40 * L.fall + Math.sin(f.f * 0.6 + L.sway) * 2 * fk;
        }
        const x = cx + Math.cos(ang) * R;
        const y = cy + Math.sin(ang) * R * 0.55 + drop;
        sprite(c, LEAF_ROT[(L.rot + (f.f >> 1) + i) % 4]!, L.pal, x - 3 * L.size, y - 3 * L.size, L.size);
      });
      if (t >= LEAF_HIT + 67 && t < LEAF_HIT + 200) impactLines(c, cx, cy, f.f, P.pale, 12, 12, 36);
      if (after(t, LEAF_HIT) && t < 1000) hitStars.forEach((st, i) => hash(f.f, i, 8) > 0.5 && star(c, st.x, st.y, st.k > 0.5 ? P.teal : P.pale, st.k > 0.75 ? 2 : 1));
      // 命中帧：粉白纸上的黑剪影，下一帧粉光一闪
      if (atFrame(t, LEAF_HIT)) invert(c, w, h, P.pale);
      else if (atFrame(t, LEAF_HIT + 67)) flash(c, w, h, P.pink, 0.16);
    },
  };
}

/* ── 风灵旋刃 ────────────────────────────────────────────────────── */
const SYLPH_HIT = 600;
const BLADES: Array<{ at: number; a0: number }> = [
  { at: 660, a0: -2.6 },
  { at: 740, a0: -0.4 },
  { at: 820, a0: 1.8 },
];

export function sylphScene(s: Stage): KindScene {
  const P = FX_PAL.sylph;
  const streaks = Array.from({ length: 18 }, () => ({ y: s.rng() * s.h, len: 6 + s.rng() * 10, v: 140 + s.rng() * 120, x0: s.rng() * (s.w + 40) }));
  const feathers = Array.from({ length: 8 }, (_, i) => ({ a0: (i * Math.PI * 2) / 8 + s.rng(), k: 4 + Math.floor(s.rng() * 10), vx: (s.rng() - 0.5) * 40, sway: s.rng() * 6 }));
  const sparks: Particle[] = BLADES.flatMap((b) => scatter(s.rng, 8, { x: s.cx, y: s.cy - 8, speed: [50, 140], born: [b.at, b.at + 30], life: [220, 380], size: 1 }));
  const fpal = { w: P.white, W: P.gust };

  const armPoint = (arm: number, k: number, t: number): { x: number; y: number } => {
    const ang = (arm * Math.PI * 2) / 3 + k * 0.42 + (t / 1000) * 7;
    const tighten = 1 - 0.55 * span(t, 0, SYLPH_HIT) + 1.4 * span(t, 820, 1500);
    const R = (5 + k * 2.4) * tighten;
    const rise = 1 + 0.3 * span(t, SYLPH_HIT - 40, 700);
    return { x: s.cx + Math.cos(ang) * R, y: s.cy + 12 - k * 2.2 * rise + Math.sin(ang) * R * 0.42 };
  };

  return {
    impactMs: SYLPH_HIT,
    shake: (t) => (!after(t, SYLPH_HIT) ? 0 : 3 * (1 - span(t, SYLPH_HIT, 900))),
    draw: (f) => {
      const { ctx: c, t, w, h, cx, cy } = f;
      // 风痕：横向刮过，越刮越密，末段褪色
      if (t < 1300) {
        streaks.forEach((k, i) => {
          if (i > t / 40) return;
          const x = ((k.x0 + (k.v * t) / 1000) % (w + 40)) - 20;
          rect(c, x, k.y, k.len, 1, ramp([i % 3 ? P.gust : P.mint, P.green, P.deep], span(t, 1000, 1300)));
        });
      }
      // 目标：被风托起 → 白闪 → 卷入旋风
      if (!after(t, SYLPH_HIT)) drawTarget(f, { wobble: true, dy: -6 * span(t, 400, SYLPH_HIT) });
      else if (!after(t, SYLPH_HIT + 134)) drawTarget(f, { flash: true, dy: -10 });
      else dissolveTarget(f, 'whirl', span(t, SYLPH_HIT + 134, 1400), [P.white, P.mint, P.green, P.deep]);
      // 三条螺旋臂
      const armFade = span(t, 1300, 1600);
      for (let arm = 0; arm < 3; arm += 1) {
        for (let k = 0; k < 17; k += 1) {
          if (hash(arm, k, f.f) < armFade) continue;
          const p = armPoint(arm, k, t);
          px(c, p.x, p.y, k < 5 ? P.mint : k < 11 ? P.green : P.deep, k < 3 ? 2 : 1);
        }
      }
      // 龙卷：命中前后拔地而起的漏斗——两侧描边、每四行一道横带、带内碎点乱飞
      if (t >= SYLPH_HIT - 40 && t < 800) {
        const gone = span(t, 700, 800);
        for (let y = cy + 14; y >= cy - 46; y -= 1) {
          const d = cy + 14 - y;
          const halfW = (2 + d * 0.34 * (1 + 0.12 * Math.sin(y * 0.7 + f.f * 1.3))) * (1 + gone * 1.5);
          if (hash(y, f.f, 6) < gone) continue;
          if ((d + f.f) % 4 === 0) rect(c, cx - halfW, y, halfW * 2, 1, P.deep);
          px(c, cx - halfW, y, P.mint, 2);
          px(c, cx + halfW - 1, y, P.mint, 2);
          if (hash(y, f.f) > 0.7) px(c, cx + (hash(y, f.f, 2) - 0.5) * 2 * halfW, y, P.gust, 1);
        }
      }
      // 羽毛：随臂盘旋，松开后摇摆落下
      feathers.forEach((F, i) => {
        if (t >= 1400 && hash(i, f.f, 9) < span(t, 1400, 1700)) return;
        const base = armPoint(i % 3, F.k, Math.min(t, 820));
        const fk = span(t, 820, 1700);
        const x = base.x + F.vx * fk + Math.sin(f.f * 0.5 + F.sway) * 3 * fk;
        const y = base.y + fk * fk * 46;
        const rot = Math.floor(((F.a0 + t / 300) / (Math.PI / 2)) % 4);
        sprite(c, FEATHER_ROT[((rot % 4) + 4) % 4]!, fpal, x - 2, y - 2, 1);
      });
      // 三道风刃：各亮三帧，过后在怪身上留一道渐淡的切痕
      BLADES.forEach((b) => {
        if (t < b.at || t >= b.at + 520) return;
        const k = span(t, b.at, b.at + 200);
        if (t < b.at + 200) crescent(c, cx, cy - 8, 26, b.a0, b.a0 + 1.6, k < 0.5 ? P.white : P.mint, P.mint, P.deep, 6);
        const mid = b.a0 + 0.8;
        line(c, cx + Math.cos(mid) * 20, cy - 8 + Math.sin(mid) * 20, cx - Math.cos(mid) * 20, cy - 8 - Math.sin(mid) * 20, ramp([P.white, P.mint, P.green, P.deep], span(t, b.at + 100, b.at + 520)), 1);
      });
      drawParts(c, sparks, t, [P.white, P.mint, P.green], 30);
      if (t >= SYLPH_HIT + 67 && t < SYLPH_HIT + 200) impactLines(c, cx, cy - 6, f.f, P.white, 12, 14, 38);
      // 命中帧：薄荷白纸上的黑剪影，下一帧薄荷一闪
      if (atFrame(t, SYLPH_HIT)) invert(c, w, h, P.white);
      else if (atFrame(t, SYLPH_HIT + 67)) flash(c, w, h, P.mint, 0.14);
    },
  };
}

/* ── 炎蛇 ───────────────────────────────────────────────────────── */
const FIRE_HIT = 620;

export function salamanderScene(s: Stage): KindScene {
  const P = FX_PAL.salamander;
  const { cx, cy } = s;
  /** 蛇路：左侧蜿蜒 → 绕怪盘三匝越缠越紧 */
  const serp = (u: number): { x: number; y: number } => {
    if (u < 0.5) {
      const k = u / 0.5;
      return { x: -12 + (cx - 28) * k, y: cy + 14 + Math.sin(u * 16) * 14 };
    }
    const v = (u - 0.5) / 0.5;
    const ang = Math.PI + v * 2.4 * Math.PI * 2;
    const R = 38 - v * 30;
    return { x: cx + Math.cos(ang) * R, y: cy + 6 + Math.sin(ang) * R * 0.5 - v * 20 };
  };
  const trail: Particle[] = Array.from({ length: 44 }, () => {
    const born = s.rng() * FIRE_HIT;
    const at = serp(born / FIRE_HIT);
    return { x: at.x, y: at.y, vx: (s.rng() - 0.5) * 10, vy: -(6 + s.rng() * 14), born, life: 300 + s.rng() * 300, size: 1 };
  });
  const embers: Particle[] = scatter(s.rng, 32, { x: cx, y: cy, speed: [40, 130], angle: [-Math.PI, 0], born: [FIRE_HIT, FIRE_HIT + 60], life: [600, 1100], size: 2 });
  const smoke = Array.from({ length: 8 }, (_, i) => ({ born: 700 + i * 50, x: cx + (s.rng() - 0.5) * 20, v: 18 + s.rng() * 12, life: 900 }));

  return {
    impactMs: FIRE_HIT,
    shake: (t) => (!after(t, FIRE_HIT) ? 0 : 4 * (1 - span(t, FIRE_HIT, 950))),
    draw: (f) => {
      const { ctx: c, t, w, h } = f;
      // 焦痕：命中后留在地上，末段渐淡
      if (t >= 640) {
        for (let dy = -4; dy <= 4; dy += 1) {
          if (hash(dy, f.f, 7) < span(t, 1300, 1800)) continue;
          const half = Math.floor(Math.sqrt(16 - dy * dy) * 2.4);
          rect(c, cx - half, cy + 16 + dy, half * 2, 1, P.dark);
        }
      }
      // 目标：被缠紧时发抖 → 白闪 → 成烬坠落
      if (!after(t, FIRE_HIT)) drawTarget(f, { wobble: true, dx: t > 400 ? (f.f % 2) - 0.5 : 0 });
      else if (!after(t, FIRE_HIT + 134)) drawTarget(f, { flash: true });
      else dissolveTarget(f, 'ash', span(t, FIRE_HIT + 134, 1450), [P.yellow, P.orange, P.red, P.ember, P.dark]);
      drawParts(c, trail, t, [P.yellow, P.orange, P.red, P.ember]);
      // 火蛇：头在前，十四节身子越往后越细
      if (!after(t, FIRE_HIT + 67)) {
        const head = Math.min(1, span(t, 0, FIRE_HIT) ** 0.9);
        for (let j = 13; j >= 0; j -= 1) {
          const u = head - j * 0.028;
          if (u < 0) continue;
          const at = serp(u);
          const size = j === 0 ? 5 : j < 4 ? 4 : j < 9 ? 3 : 2;
          disc3(c, at.x, at.y, size, j === 0 ? [P.orange, P.yellow, P.white] : [P.red, P.orange, P.yellow]);
          if (j === 0) px(c, at.x + 2, at.y - 2, P.dark, 1);
        }
      }
      // 火球：胀大 → 掏空成环
      if (after(t, FIRE_HIT) && t < 940) {
        if (t < 780) disc3(c, cx, cy, 4 + 20 * span(t, FIRE_HIT, 780), [P.red, P.orange, P.yellow]);
        else ring(c, cx, cy, 24 + 6 * span(t, 780, 940), ramp([P.orange, P.red, P.ember], span(t, 780, 940)), 3);
      }
      // 地面火环 + 顶缘火舌
      if (t >= 640 && t < 1080) {
        const k = span(t, 640, 1080);
        const r = 6 + 44 * k;
        ring(c, cx, cy + 10, r, ramp([P.yellow, P.orange, P.red, P.ember], k), 3, 0.5);
        for (let i = 0; i <= 11; i += 1) {
          const a = -Math.PI + (i * Math.PI) / 11;
          const x = cx + Math.cos(a) * r;
          const y = cy + 10 + Math.sin(a) * r * 0.5;
          const hh = 2 + Math.round(hash(f.f, i) * 3);
          rect(c, x, y - hh, 1, hh, P.orange);
          px(c, x, y - hh - 1, P.yellow, 1);
        }
      }
      // 第二道小火环：慢半拍跟上，给爆炸一点纵深
      if (t >= 800 && t < 1150) {
        const k = span(t, 800, 1150);
        ring(c, cx, cy + 10, 4 + 30 * k, ramp([P.yellow, P.orange, P.red, P.ember], k), 2, 0.5);
      }
      if (t >= FIRE_HIT + 67 && t < FIRE_HIT + 200) impactLines(c, cx, cy, f.f, P.yellow, 14, 16, 42);
      drawParts(c, embers, t, [P.yellow, P.orange, P.red, P.ember, P.dark], 110);
      // 烟团：上升、胀大、变淡
      smoke.forEach((m) => {
        const age = t - m.born;
        if (age < 0 || age > m.life) return;
        const k = age / m.life;
        c.globalAlpha = k < 0.5 ? 0.6 : 0.3;
        disc(c, m.x + Math.sin(k * 5) * 3, cy - 6 - (m.v * age) / 1000, 2 + 5 * k, k < 0.6 ? P.smoke : P.soot);
        c.globalAlpha = 1;
      });
      // 命中帧：焰黄纸上的黑剪影，下一帧焰黄一闪
      if (atFrame(t, FIRE_HIT)) invert(c, w, h, P.yellow);
      else if (atFrame(t, FIRE_HIT + 67)) flash(c, w, h, P.yellow, 0.18);
    },
  };
}
