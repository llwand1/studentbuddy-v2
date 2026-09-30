/**
 * features/continent/BattleStage — 讨伐弹窗顶上的**横版战场**（canvas 壳；绘制口径在 `battle-stage.ts`）。
 *
 * ★ 只做三件事：建引擎、rAF 循环喂 `performance.now()`、把父组件的事件转成 `engine.trigger`。
 *   血量（`hp/maxHp`）每帧从 props 读——战场上的血滴与弹窗里的血条是同一份数，不各记一份。
 * ★ 减少动态效果：`prefers-reduced-motion` ⇒ 引擎不突进不抖不呼吸，且循环降到 6 fps（只为把白闪/淡出画出来）。
 * ★ 测试环境 `getContext` 返回 null ⇒ 什么也不画、不起循环（页面测试早就这么桩 canvas）。
 */
import { useEffect, useRef } from 'react';
import { BattleEngine, STAGE_H, STAGE_W, type BattleEvent } from './battle-stage';
import type { ContinentTileView } from './continent-view';
import { monsterLook } from './monster-art';

interface Props {
  tile: ContinentTileView;
  hp: number;
  maxHp: number;
  /** 最近一次战斗事件（`seq` 变了才算新事件） */
  event: BattleEvent | null;
}

export function BattleStage({ tile, hp, maxHp, event }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<BattleEngine | null>(null);
  const hpRef = useRef({ hp, maxHp });
  hpRef.current = { hp, maxHp };
  const look = monsterLook(tile.species);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const engine = new BattleEngine(look, tile.level, reduced);
    engineRef.current = engine;
    ctx.imageSmoothingEnabled = false;
    let raf = 0;
    let timer = 0;
    const frame = (): void => {
      engine.draw(ctx, performance.now(), hpRef.current.hp, hpRef.current.maxHp);
      if (reduced) timer = window.setTimeout(() => (raf = requestAnimationFrame(frame)), 160);
      else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      engineRef.current = null;
    };
  }, [look, tile.level]);

  useEffect(() => {
    if (event) engineRef.current?.trigger(event.kind, performance.now());
  }, [event]);

  // ★ 外面包一层全宽的黑幕：矮屏（手机横屏 / 小窗）下画布按 34vh 封顶并保持 16:9，两侧留黑边而不是把像素拉扁；
  //   题卡与「提交」永远要留得下——弹窗本身可滚（`.continent-modal-card` 的 overflow:auto 不被覆盖）。
  return (
    <div className="continent-stage-wrap">
      <canvas
        ref={canvasRef}
        className="continent-stage"
        width={STAGE_W}
        height={STAGE_H}
        role="img"
        aria-label={`横版战场：勇者对阵「${tile.term}」的${look.name}，剩余 ${hp} / ${maxHp} 滴血`}
      />
    </div>
  );
}
