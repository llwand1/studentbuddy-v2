/**
 * features/continent/battle-stage — 讨伐的**横版战场**绘制引擎（纯 canvas 指令，无 React；2026-09-30，
 * 契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「横版战斗」）。
 *
 * ── 为什么要有它 ─────────────────────────────────────────────────────────────
 * 落地页第一章一直在说"出发讨伐时镜头切进横版战场"，正式产品里却只有一个答题弹窗——货不对板。
 * 现在弹窗上方就是这块战场：左边勇者（落地页序章同一个 `HERO_MAP`）、右边这只怪（地图上同一张脸 `monsterLook`），
 * 布景直接复用序章的 `Scenery`（天空色带 / 血月 / 远景废墟 / 地面 / 雾）——门面与正式版是同一片大陆。
 *
 * ── 演出口径 ─────────────────────────────────────────────────────────────────
 *   · 低清画布 `W×H = 320×180`，CSS `image-rendering: pixelated` 放大 ⇒ 边永远是硬方块。
 *   · 事件驱动：`hit`（答对：勇者突进、怪白闪后退、掉一滴血）/ `miss`（答错：怪扑过来、勇者白闪、镜头抖）/
 *     `spell`（吟唱命中：符文环 + 白闪）/ `defeat`（最后一击：怪逐行错位化沙、一束金光）。
 *     每个事件 ≤ 700 ms（本仓特效预算：单次过渡 ≤ 1 s）。
 *   · **减少动态效果**：不突进、不抖、不呼吸、雾不飘；只保留白闪与最终的淡出（信息仍在，演出让位）。
 *   · 不读时钟：`draw(ctx, now)` 由外面喂 `performance.now()`。
 */
import { HERO_MAP, HERO_PAL, RUNE_MAP, drawSprite, spriteSize } from '../../app/hero/hero-sprites';
import { GROUND_Y, Scenery } from '../../app/hero/hero-scene';
import type { MonsterLook } from './monster-art';

export const STAGE_W = 320;
export const STAGE_H = 180;

export type BattleEventKind = 'hit' | 'miss' | 'spell' | 'defeat';
export interface BattleEvent {
  kind: BattleEventKind;
  /** 事件序号（同一种事件连着发两次也要各演一遍） */
  seq: number;
}

/** 各事件时长（ms） */
export const BATTLE_EVENT_MS: Record<BattleEventKind, number> = { hit: 420, miss: 460, spell: 600, defeat: 700 };

const HERO_SCALE = 2;
const MONSTER_SCALE = 3;
const HERO_X = 78;
const MONSTER_X = 222;

/** 缓动：先快后慢 */
const easeOut = (p: number): number => 1 - (1 - p) * (1 - p);

export class BattleEngine {
  private readonly scene: Scenery;
  private event: { kind: BattleEventKind; at: number } | null = null;
  /** 怪已倒下（`defeat` 演完之后保持消失，别又站起来） */
  private down = false;

  constructor(
    private readonly look: MonsterLook,
    private readonly level: number,
    private readonly reduced: boolean,
  ) {
    this.scene = new Scenery(STAGE_W, STAGE_H);
  }

  /** 触发一个事件（从现在起演 `BATTLE_EVENT_MS[kind]` 毫秒） */
  trigger(kind: BattleEventKind, now: number): void {
    this.event = { kind, at: now };
    if (kind === 'defeat') this.down = true;
  }

  /** 当前事件进度 0..1（没有事件或已演完 ⇒ null） */
  private progress(now: number): { kind: BattleEventKind; p: number } | null {
    if (!this.event) return null;
    const p = (now - this.event.at) / BATTLE_EVENT_MS[this.event.kind];
    if (p >= 1) return this.event.kind === 'defeat' ? { kind: 'defeat', p: 1 } : null;
    return { kind: this.event.kind, p: Math.max(0, p) };
  }

  draw(ctx: CanvasRenderingContext2D, now: number, hp: number, maxHp: number): void {
    const t = this.reduced ? 0 : now / 1000;
    const ev = this.progress(now);
    const shake = ev?.kind === 'miss' && !this.reduced ? Math.round(Math.sin(ev.p * 40) * 2 * (1 - ev.p)) : 0;
    ctx.save();
    ctx.translate(shake, 0);
    ctx.clearRect(-4, -4, STAGE_W + 8, STAGE_H + 8);
    this.scene.drawBack(ctx, t, 0, 250);
    this.scene.drawGround(ctx, 0);
    if (!this.reduced) this.scene.drawFog(ctx, t * 1.2, GROUND_Y - 6, '#3a2630', 0.16);

    // ── 勇者（左，面朝右）
    const heroSize = spriteSize(HERO_MAP, HERO_SCALE);
    let hx = HERO_X;
    let heroFlash = false;
    if (ev && !this.reduced) {
      if (ev.kind === 'hit' || ev.kind === 'spell') hx += Math.round(Math.sin(Math.min(ev.p, 1) * Math.PI) * (ev.kind === 'hit' ? 40 : 10));
      if (ev.kind === 'miss') heroFlash = ev.p > 0.35 && ev.p < 0.7;
    } else if (ev?.kind === 'miss') heroFlash = ev.p < 0.5;
    const breathe = this.reduced ? 0 : Math.round(Math.sin(t * 2.2));
    drawSprite(ctx, HERO_MAP, HERO_PAL, hx, GROUND_Y - heroSize.h + breathe, { scale: HERO_SCALE, flash: heroFlash });

    // ── 怪（右，面朝左）
    const mSize = spriteSize(this.look.map, MONSTER_SCALE);
    let mx = MONSTER_X;
    let monsterFlash = false;
    let alpha = 1;
    let rowShift: ((row: number) => number) | undefined;
    if (ev) {
      if (ev.kind === 'hit' || ev.kind === 'spell') {
        monsterFlash = ev.p > 0.3 && ev.p < 0.62;
        if (!this.reduced) mx += Math.round(easeOut(Math.max(0, (ev.p - 0.3) / 0.7)) * 10);
      }
      if (ev.kind === 'miss' && !this.reduced) mx -= Math.round(Math.sin(Math.min(ev.p, 1) * Math.PI) * 46);
      if (ev.kind === 'defeat') {
        alpha = this.reduced ? (ev.p >= 1 ? 0 : 1) : 1 - ev.p;
        if (!this.reduced) rowShift = (row) => Math.round(Math.sin(row * 1.7 + ev.p * 9) * ev.p * 6);
      }
    }
    if (this.down && !ev) alpha = 0;
    const bob = this.reduced || this.down ? 0 : Math.round(Math.sin(t * 3 + 1) * 1.5);
    if (alpha > 0) {
      drawSprite(ctx, this.look.map, this.look.pal, mx, GROUND_Y - mSize.h + bob, {
        scale: MONSTER_SCALE,
        flip: true,
        flash: monsterFlash,
        alpha,
        ...(rowShift ? { rowShift } : {}),
      });
      // 头顶等级角 + 血滴（题数 = 血量，与弹窗里的血条同一份数）
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#e0c36b';
      for (let i = 0; i < this.level; i += 1) ctx.fillRect(mx + mSize.w / 2 + (i - (this.level - 1) / 2) * 6 - 1, GROUND_Y - mSize.h - 8, 3, 3);
      for (let i = 0; i < maxHp; i += 1) {
        ctx.fillStyle = i < hp ? '#ff4a6a' : '#3a1622';
        ctx.fillRect(mx + mSize.w / 2 + (i - (maxHp - 1) / 2) * 6 - 2, GROUND_Y - mSize.h - 16, 4, 4);
      }
      ctx.globalAlpha = 1;
    }

    // ── 事件特效
    if (ev?.kind === 'spell') {
      const r = 6 + Math.round(ev.p * 14);
      ctx.strokeStyle = '#ffd27a';
      ctx.globalAlpha = 1 - ev.p;
      ctx.lineWidth = 2;
      ctx.strokeRect(mx + mSize.w / 2 - r, GROUND_Y - mSize.h / 2 - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
      drawSprite(ctx, RUNE_MAP, { x: '#ffe39a' }, mx + mSize.w / 2 - 5, GROUND_Y - mSize.h - 28 - Math.round(ev.p * 10), { scale: 2 });
    }
    if (ev?.kind === 'hit' && ev.p > 0.3 && ev.p < 0.7) {
      ctx.fillStyle = '#fff4e0';
      const cx = mx + 4;
      const cy = GROUND_Y - mSize.h / 2;
      for (const [dx, dy] of [[-6, 0], [6, 0], [0, -6], [0, 6], [0, 0]]) ctx.fillRect(cx + dx! - 1, cy + dy! - 1, 3, 3);
    }
    if (ev?.kind === 'defeat') {
      ctx.fillStyle = '#ffe39a';
      ctx.globalAlpha = (1 - ev.p) * 0.8;
      ctx.fillRect(mx + mSize.w / 2 - 2, 0, 4, GROUND_Y);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}
