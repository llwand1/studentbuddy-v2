/**
 * spell-fx.test — 魔法吟唱释放特效引擎（契约 `docs/SPELL-CHANT-SPEC.md` §3.4）：用软件栅格器**真的把帧画出来**再看像素。
 *
 * ★ 锁八条：
 *   ① 五款各自的命中帧常量 === shared `SPELL_KIND_META[kind].impactMs`（DOM 计时器与 canvas 编排查同一张表；
 *      漂了 1 帧就是"数字先弹、画面后炸"）；时长同理。
 *   ② 整条时间线每一帧都能画（引擎只许用软件栅格器实现的那一小撮 canvas API——越界当场 TypeError）。
 *   ③ 调色板纪律：一款只用自己的 `FX_PAL[kind]` + 靶子（幽魂）色 + 三个公共色（负片纸白/闪白/黑）——五款各有各的色，
 *      不许"借"别款的颜色；地图版 `spell-burst.ts` 同样约束。
 *   ④ 命中帧 = 整屏负片：满覆盖、平均亮度陡升；命中前一帧则不亮。
 *   ⑤ 靶子在命中前站在那里（靶区覆盖高），到收尾帧已经消散（靶区几乎空）。
 *   ⑥ 同 seed 逐帧相同、异 seed 不同（随机量只来自 seed，截图/接触印相可复现）。
 *   ⑦ 画布尺寸：高固定、宽随长宽比钳在 [FX_MIN_W, FX_MAX_W]。
 *   ⑧ 地图版收复特效：五款都能在 `SPELL_BURST_MS`（≤ 1s）内画完整条时间线、真的有像素落在格上、且到时长即净。
 */
import { describe, expect, it } from 'vitest';
import { SPELL_KINDS, SPELL_KIND_META, type SpellKind } from '@sb/shared';
import { WRAITH_PAL } from '../../app/hero/hero-sprites';
import { FX_PAL } from './spell-fx-art';
import { FX_MAX_W, FX_MIN_W, targetBox } from './spell-fx-core';
import { FX_H, FX_TICK_MS, createSpellScene, fxSize } from './spell-fx';
import { SoftCtx, asCtx } from './spell-fx-soft';
import { SPELL_BURST_MS, drawSpellBurst } from './spell-burst';

const W = 200;
const SHARED_COLORS = ['#fff4e0', '#ffffff', '#000000'];

function frame(kind: SpellKind, seed: number, ms: number): SoftCtx {
  const soft = new SoftCtx(W, FX_H);
  createSpellScene(kind, seed, W, FX_H).draw(asCtx(soft), ms);
  return soft;
}

/** 靶子（幽魂）所在的低清矩形 */
function box(): { x: number; y: number; w: number; h: number } {
  return targetBox({ ctx: asCtx(new SoftCtx(W, FX_H)), t: 0, f: 0, w: W, h: FX_H, cx: Math.round(W / 2), cy: Math.round(FX_H * 0.54) });
}

function allowedColors(kind: SpellKind): Set<string> {
  return new Set([...Object.values(FX_PAL[kind]), ...Object.values(WRAITH_PAL), ...SHARED_COLORS].map((c) => c.toLowerCase()));
}

describe('魔法吟唱释放特效引擎', () => {
  it('① 每款的命中帧 / 时长与 shared 的款式表一致', () => {
    for (const kind of SPELL_KINDS) {
      const scene = createSpellScene(kind, 1, W, FX_H);
      expect(scene.impactMs, kind).toBe(SPELL_KIND_META[kind].impactMs);
      expect(scene.durationMs, kind).toBe(SPELL_KIND_META[kind].durationMs);
      expect(scene.impactMs % FX_TICK_MS, `${kind} 的命中帧不该正好卡在帧界上`).not.toBe(0);
    }
  });

  it('②③ 整条时间线都画得出来，且一款只用自己的调色板', () => {
    for (const kind of SPELL_KINDS) {
      const used = new Set<string>();
      const scene = createSpellScene(kind, 3, W, FX_H);
      for (let ms = 0; ms < scene.durationMs + FX_TICK_MS; ms += FX_TICK_MS) {
        const soft = new SoftCtx(W, FX_H);
        scene.draw(asCtx(soft), ms);
        soft.colors.forEach((c) => used.add(c));
      }
      const allowed = allowedColors(kind);
      const strangers = [...used].filter((c) => !allowed.has(c));
      expect(strangers, `${kind} 用了别处的颜色`).toEqual([]);
      expect(used.size, `${kind} 至少要用到自己调色板的一半`).toBeGreaterThanOrEqual(Object.keys(FX_PAL[kind]).length / 2);
    }
  });

  it('④ 命中帧整屏负片发白，前一帧不白；⑤ 靶子命中前在、收尾时没了', () => {
    const b = box();
    for (const kind of SPELL_KINDS) {
      const { impactMs, durationMs } = SPELL_KIND_META[kind];
      const hit = frame(kind, 5, impactMs).stats();
      const before = frame(kind, 5, impactMs - FX_TICK_MS).stats();
      expect(hit.coverage, `${kind} 命中帧应满屏`).toBe(1);
      expect(hit.luma, `${kind} 命中帧应发白`).toBeGreaterThan(0.75);
      expect(before.luma, `${kind} 命中前一帧不该发白`).toBeLessThan(0.4);

      const standing = frame(kind, 5, Math.round(impactMs * 0.6)).stats(b.x, b.y, b.w, b.h);
      const gone = frame(kind, 5, durationMs - 1).stats(b.x, b.y, b.w, b.h);
      expect(standing.coverage, `${kind} 命中前靶子应站在靶区`).toBeGreaterThan(0.5);
      expect(gone.coverage, `${kind} 收尾时靶区应基本空了`).toBeLessThan(0.1);
    }
  });

  it('⑥ 同 seed 逐帧相同，异 seed 不同', () => {
    for (const kind of SPELL_KINDS) {
      const ms = SPELL_KIND_META[kind].impactMs + 200;
      expect(frame(kind, 11, ms).buf, kind).toEqual(frame(kind, 11, ms).buf);
      expect(frame(kind, 11, ms).buf, kind).not.toEqual(frame(kind, 12, ms).buf);
    }
  });

  it('⑦ 画布高固定、宽按长宽比钳住', () => {
    expect(fxSize(0, 0)).toEqual({ w: 192, h: FX_H });
    expect(fxSize(1000, 100)).toEqual({ w: FX_MAX_W, h: FX_H });
    expect(fxSize(50, 100)).toEqual({ w: FX_MIN_W, h: FX_H });
    expect(fxSize(480, 320)).toEqual({ w: 180, h: FX_H });
  });

  it('⑧ 地图版收复特效：五款都在 1s 内画完、有像素、调色板同款、到时即净', () => {
    expect(SPELL_BURST_MS).toBeLessThanOrEqual(1000);
    const size = 144; // 三格见方，格中心在 (72, 72)
    for (const kind of SPELL_KINDS) {
      const used = new Set<string>();
      let peak = 0;
      for (let age = 0; age < SPELL_BURST_MS; age += FX_TICK_MS) {
        const soft = new SoftCtx(size, size);
        drawSpellBurst(asCtx(soft), 72, 72, age, kind);
        soft.colors.forEach((c) => used.add(c));
        peak = Math.max(peak, soft.stats().coverage);
      }
      const allowed = allowedColors(kind);
      expect([...used].filter((c) => !allowed.has(c)), `${kind} 地图版用了别处的颜色`).toEqual([]);
      expect(peak, `${kind} 地图版得真的画了东西`).toBeGreaterThan(0.03);
      expect(peak, `${kind} 地图版不该把三格都糊满`).toBeLessThan(0.5);
      const end = new SoftCtx(size, size);
      drawSpellBurst(asCtx(end), 72, 72, SPELL_BURST_MS + FX_TICK_MS, kind);
      expect(end.stats().coverage, `${kind} 过了时长就不该再留东西`).toBeLessThan(0.01);
      const again = new SoftCtx(size, size);
      drawSpellBurst(asCtx(again), 72, 72, 400, kind);
      const once = new SoftCtx(size, size);
      drawSpellBurst(asCtx(once), 72, 72, 400, kind);
      expect(again.buf, `${kind} 地图版同一帧必须逐像素相同`).toEqual(once.buf);
    }
  });
});
