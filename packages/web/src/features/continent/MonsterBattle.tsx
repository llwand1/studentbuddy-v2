/**
 * features/continent/MonsterBattle — 打怪弹窗顶部的**横版讨伐战**画面（2026-09-28，兑现首页
 * 「走到怪物身边发起讨伐，平面地图转场成横版战斗」）。
 *
 * ★ 纯演出层：不判分、不改账。弹窗每答对一题 `hits` +1（勇者冲刺斩击、怪闪白掉血），
 *   答错 `misses` +1（怪物晃一下、嘲讽；★ 不伤勇者——本体规则是「答错不扣分、可重试」）。
 * ★ 画面复用首页首屏的同一套素材：`Scenery`（血月、废墟、雾）、`HERO_MAP` 红披风勇者、`WRAITH_MAP` 遗忘之影。
 * ★ 开场是像素溶解转场（约 0.5 秒）：从俯视地图「切」进横版战场。
 * ★ `prefers-reduced-motion`：跳过转场与冲刺，只画静止帧（血量照样更新）。
 */
import { useEffect, useRef } from 'react';
import { GROUND_Y, Scenery } from '../../app/hero/hero-scene';
import { HERO_MAP, HERO_PAL, WRAITH_MAP, WRAITH_PAL, drawSprite } from '../../app/hero/hero-sprites';

const W = 320;
const H = 180;
const DISSOLVE_MS = 520;
const LUNGE_MS = 420;

interface Props {
  /** 怪物总血量（= 题数） */
  maxHp: number;
  /** 已答对的题数 */
  hits: number;
  /** 已答错的次数（只做怪物嘲讽的演出） */
  misses: number;
  term: string;
}

export function MonsterBattle({ maxHp, hits, misses, term }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ hits, misses, hitAt: -1e9, missAt: -1e9 });

  useEffect(() => {
    const s = live.current;
    const now = performance.now();
    if (hits > s.hits) s.hitAt = now;
    if (misses > s.misses) s.missAt = now;
    s.hits = hits;
    s.misses = misses;
  }, [hits, misses]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return; // jsdom 没有 canvas：演出层直接缺席，不影响答题
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scene = new Scenery(W, H);
    const start = performance.now();
    let raf = 0;
    const foeScale = 2 + Math.min(2, Math.floor(maxHp / 2));

    const frame = (now: number) => {
      const t = calm ? 0 : (now - start) / 1000;
      const s = live.current;
      ctx.imageSmoothingEnabled = false;
      scene.drawBack(ctx, t, 0, W * 0.72);
      scene.drawFog(ctx, t, GROUND_Y - 22, '#3a1a24', 0.35);
      scene.drawGround(ctx, 0);

      // 勇者：答对时向前冲刺 → 斩击 → 回位
      const la = calm ? 1 : Math.min((now - s.hitAt) / LUNGE_MS, 1);
      const dash = la < 1 ? Math.round(Math.sin(la * Math.PI) * 120) : 0;
      const heroX = 44 + dash;
      const heroY = GROUND_Y - 17 * 2;
      const bob = calm ? 0 : Math.floor(t * 2) % 2;
      drawSprite(ctx, HERO_MAP, HERO_PAL, heroX, heroY - bob, { scale: 2 });

      // 怪：血量归零则倒下；受击闪白；答错时得意地晃
      const dead = s.hits >= maxHp;
      const flash = !calm && now - s.hitAt < 160 + LUNGE_MS / 2 && now - s.hitAt > LUNGE_MS / 2 - 40;
      const mock = calm ? 0 : now - s.missAt < 500 ? Math.round(Math.sin((now - s.missAt) / 40) * 3) : 0;
      const fw = 16 * foeScale;
      const fh = 15 * foeScale;
      const foeX = W - 40 - fw + mock;
      const foeY = GROUND_Y - fh + (dead ? Math.round(fh * 0.5) : 0) - (calm ? 0 : Math.round(Math.sin(t * 2) * 2));
      drawSprite(ctx, WRAITH_MAP, WRAITH_PAL, foeX, foeY, { scale: foeScale, flip: true, flash, alpha: dead ? 0.35 : 1 });
      ctx.globalAlpha = 1;

      // 斩击弧光（冲刺到最远处时）
      if (!calm && la > 0.35 && la < 0.75) {
        ctx.fillStyle = '#ffe39a';
        for (let i = 0; i < 6; i++) ctx.fillRect(foeX - 6 + i * 3, foeY + fh / 2 - 12 + i * 4, 3, 3);
      }

      // 血条（怪头顶）：题数 = 血量
      const bw = 8 * maxHp + 2;
      const bx = Math.round(foeX + fw / 2 - bw / 2);
      const by = Math.max(4, foeY - 10);
      ctx.fillStyle = '#000';
      ctx.fillRect(bx - 1, by - 1, bw + 2, 7);
      for (let i = 0; i < maxHp; i++) {
        ctx.fillStyle = i < maxHp - s.hits ? '#d9434f' : '#2a1116';
        ctx.fillRect(bx + 1 + i * 8, by + 1, 6, 3);
      }

      // 勇者脚下的名牌与怪物名牌
      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(0, H - 14, W, 14);
      ctx.fillStyle = '#e8c46a';
      ctx.font = '8px monospace';
      ctx.fillText('YOU', 8, H - 4);
      ctx.fillStyle = '#ff8a8a';
      ctx.textAlign = 'right';
      ctx.fillText(dead ? 'DEFEATED' : `HP ${maxHp - s.hits}/${maxHp}`, W - 8, H - 4);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;

      // 开场像素溶解：从俯视地图切进战场
      const d = calm ? 1 : (now - start) / DISSOLVE_MS;
      if (d < 1) {
        ctx.fillStyle = '#07050a';
        const cell = 8;
        for (let y = 0; y < H; y += cell) {
          for (let x = 0; x < W; x += cell) {
            const h = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000;
            if (h / 1000 > d) ctx.fillRect(x, y, cell, cell);
          }
        }
      }
      if (!calm) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [maxHp]);

  return (
    <div className="continent-battle">
      <canvas ref={ref} width={W} height={H} className="continent-battle-canvas" aria-hidden="true" />
      <p className="continent-battle-cap">讨伐战 · 遗忘之影「{term}」—— 答对一题就是一次斩击</p>
    </div>
  );
}
