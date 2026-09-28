/**
 * spell-fx — 魔法吟唱释放特效的入口：按款式建场景、按毫秒画一帧（契约 docs/SPELL-CHANT-SPEC.md §3.4）。
 *
 * ★ 五款各是一套独立编排（`spell-fx-gothic.ts` / `spell-fx-elements.ts`），这里只做三件事：
 *   ① 把 `seed` 变成场景（随机量在此一次撒完）；② 把毫秒定格成帧（`FX_TICK_MS`），帧间不插值；
 *   ③ 命中后的震屏——整块画布按帧序号整数抖动，抖动量由各款自己给。
 * ★ 时长 / 命中帧不在这里定，来自 shared 的 `SPELL_KIND_META`：DOM（伤害数字、卡片震动、结算切换）与
 *   canvas 拿的是同一张表。
 * ★ `draw(ctx, ms)` 是 (seed, ms) 的纯函数：同 seed 逐帧相同 ⇒ 测试与截图脚本都能复现同一帧。
 */
import { SPELL_KIND_META, type SpellKind } from '@sb/shared';
import { FX_H, FX_MAX_W, FX_MIN_W, FX_TICK_MS, mulberry, shakeOffset, type Ctx } from './spell-fx-core';
import { duskScene, graceScene, type KindScene, type Stage } from './spell-fx-gothic';
import { leafScene, salamanderScene, sylphScene } from './spell-fx-elements';

export { FX_H, FX_TICK_MS, FX_FPS } from './spell-fx-core';

export interface SpellScene {
  kind: SpellKind;
  seed: number;
  w: number;
  h: number;
  durationMs: number;
  /** 命中毫秒：来自该款编排自己的常量（测试锁它 === shared 表，DOM 计时器查的是 shared 表） */
  impactMs: number;
  /** 画 `ms` 时刻那一帧（调用方负责 clearRect；本函数不清屏，方便叠残影调试） */
  draw: (ctx: Ctx, ms: number) => void;
}

const BUILDERS: Record<SpellKind, (s: Stage) => KindScene> = {
  dusk: duskScene,
  grace: graceScene,
  leaf: leafScene,
  sylph: sylphScene,
  salamander: salamanderScene,
};

/** 低清画布尺寸：高固定，宽按容器长宽比、钳在 [FX_MIN_W, FX_MAX_W] */
export function fxSize(cssW: number, cssH: number): { w: number; h: number } {
  const aspect = cssW > 0 && cssH > 0 ? cssW / cssH : 1.6;
  return { w: Math.max(FX_MIN_W, Math.min(FX_MAX_W, Math.round(FX_H * aspect))), h: FX_H };
}

export function createSpellScene(kind: SpellKind, seed: number, w: number, h: number): SpellScene {
  const meta = SPELL_KIND_META[kind];
  const stage: Stage = { rng: mulberry(seed), w, h, cx: Math.round(w / 2), cy: Math.round(h * 0.54) };
  const scene = BUILDERS[kind](stage);
  return {
    kind,
    seed,
    w,
    h,
    durationMs: meta.durationMs,
    impactMs: scene.impactMs,
    draw: (ctx, ms) => {
      const f = Math.max(0, Math.floor(ms / FX_TICK_MS));
      const t = (f + 0.5) * FX_TICK_MS;
      const [sx, sy] = shakeOffset(f, scene.shake(t));
      ctx.save();
      ctx.translate(sx, sy);
      scene.draw({ ctx, t, f, w, h, cx: stage.cx, cy: stage.cy });
      ctx.restore();
    },
  };
}
