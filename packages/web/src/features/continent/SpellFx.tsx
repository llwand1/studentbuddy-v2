/**
 * features/continent/SpellFx — 释放特效的画布壳（契约 docs/SPELL-CHANT-SPEC.md §3.4）。
 *
 * ★ 只做三件事：① 按容器长宽比定低清画布尺寸（高 `FX_H`，CSS `image-rendering: pixelated` 放大）；
 *   ② 用 rAF 驱动 `createSpellScene(kind, seed).draw`，**帧序号变了才重画**（定格节奏在引擎里，这里只是不多画）；
 *   ③ 到时长即停。时序（伤害数字 / 卡片震动 / 结算切换）不归它管——`SpellChant` 用 shared 同一张表起计时器。
 * ★ jsdom 没有 canvas（`getContext` 返回 null）⇒ 静默不画；`prefers-reduced-motion` 由父组件决定根本不进 cast 阶段。
 */
import { useEffect, useRef } from 'react';
import type { SpellKind } from '@sb/shared';
import { FX_TICK_MS, createSpellScene, fxSize } from './spell-fx';

interface Props {
  kind: SpellKind;
  /** 场景种子：同 seed 同画面（父组件每次释放换一个） */
  seed: number;
}

export function SpellFx({ kind, seed }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = fxSize(canvas.clientWidth, canvas.clientHeight);
    canvas.width = w;
    canvas.height = h;
    const scene = createSpellScene(kind, seed, w, h);
    const start = performance.now();
    let raf = 0;
    let last = -1;
    const loop = (now: number): void => {
      const ms = now - start;
      const f = Math.floor(ms / FX_TICK_MS);
      if (f !== last) {
        last = f;
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = false;
        scene.draw(ctx, ms);
      }
      if (ms < scene.durationMs + FX_TICK_MS) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [kind, seed]);

  return <canvas ref={ref} className="spell-fx" aria-hidden="true" data-kind={kind} />;
}
