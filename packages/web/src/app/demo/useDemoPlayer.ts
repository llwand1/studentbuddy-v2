/**
 * landing 演示播放器 —— 唯一的计时器持有者。
 *
 * ★ 职责边界：外壳只问它「现在是第几帧」，它不关心帧里画什么。帧渲染器保持无状态，
 *   这样新增演示时不需要碰计时逻辑（同一个播放器服务全部演示）。
 *
 * ★ 尊重系统「减少动态效果」：命中 `prefers-reduced-motion: reduce` 时**停在最后一帧**
 *   （而不是第一帧）——最后一帧是完整界面，静态可读；第一帧是空白舞台，停下等于给用户
 *   看一个空盒子。同时不自动轮播，重播由用户显式点。
 *
 * ★ `matchMedia` 必须在 effect 里问而不是在渲染期问：jsdom（组件测试环境）没有实现
 *   它，渲染期调用会在测试里直接抛；且服务端渲染路径没有 `window`。故做三重防御。
 */
import { useCallback, useEffect, useState } from 'react';
import type { DemoStage } from './registry';

/** 用户是否要求减少动态效果（jsdom / 无 window 环境下恒 false） */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export type DemoPlayer = {
  /** 当前帧序号，恒在 `[0, stages.length)` 内 */
  stage: number;
  /** 从头再播一次（重置到第 0 帧并重挂计时器） */
  replay: () => void;
  /** 是否因「减少动态效果」而停在静态末帧 */
  still: boolean;
};

export function useDemoPlayer(stages: DemoStage[]): DemoPlayer {
  const [stage, setStage] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [still, setStill] = useState(false);

  useEffect(() => {
    setStill(prefersReducedMotion());
  }, []);

  useEffect(() => {
    setStage(0);
    // 静态模式：直接落到末帧，不排任何计时器
    if (still) {
      setStage(stages.length - 1);
      return;
    }
    let alive = true;
    let timer = 0;
    const tick = (i: number) => {
      const cur = stages[i];
      timer = window.setTimeout(() => {
        if (!alive) return;
        const next = (i + 1) % stages.length;
        setStage(next);
        tick(next);
      }, cur ? cur.ms : 4000);
    };
    tick(0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [stages, still, nonce]);

  const replay = useCallback(() => setNonce((n) => n + 1), []);
  return { stage, replay, still };
}
