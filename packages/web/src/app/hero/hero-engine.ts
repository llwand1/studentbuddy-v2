/**
 * hero-engine — 落地页序章「词条即力量」的画布引擎（纯演出，**不读写任何用户数据**）。
 *
 * ★ 与产品真实功能的对应（门面演出，不另算数值）：
 *   怪物＝到期没复习的词条（知识大陆的复习怪物）；怪物头上的谜题＝练习题；
 *   手牌＝你的词条卡；选对词条＝"理解"，一击暴击；选错＝"只是记住"，伤害微弱且会被反击。
 *   击败后收复一块地、得到一张卡——对应大陆收复地块与卡牌收集。**这里的 HP/伤害都是演出常量**，
 *   不代表产品里的任何数值（产品数值的事实源见 PIXEL-UI.md）。
 * ★ React 只负责 DOM 层（字幕 / 手牌 / Boss 血条 / 伤害飘字），本文件只画画布并通过 `emit` 报状态。
 */
import { BLOB_MAP, BLOB_PAL, BOSS_MAP, BOSS_PAL, HERO_MAP, HERO_PAL, RUNE_MAP, WRAITH_MAP, WRAITH_PAL, drawSprite, spriteSize } from './hero-sprites';
import type { Palette, SpriteMap } from './hero-sprites';
import { GROUND_Y, Scenery } from './hero-scene';
import type { Light } from './hero-scene';
import { CARDS, WAVES } from './hero-copy';

export type Phase = 'intro' | 'fight' | 'victory';
export type PopKind = 'crit' | 'weak' | 'hurt' | 'loot';
export type HeroSnap = { phase: Phase; wave: number; hp: number; max: number; kills: number; busy: boolean; ready: boolean };
export type HeroEmit = { snap: (s: HeroSnap) => void; pop: (kind: PopKind, xf: number, yf: number) => void; impact: (kind: 'crit' | 'weak' | 'kill' | 'hurt') => void };

type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; home?: boolean };
type Shot = { sx: number; sy: number; tx: number; ty: number; t: number; dur: number; delay: number; card: number };
type Monster = { kind: number; x: number; tx: number; hp: number; max: number; flash: number; die: number; lunge: number; ready: boolean };

const SPR: Array<{ map: SpriteMap; pal: Palette; scale: number }> = [
  { map: WRAITH_MAP, pal: WRAITH_PAL, scale: 2 },
  { map: BLOB_MAP, pal: BLOB_PAL, scale: 2 },
  { map: BOSS_MAP, pal: BOSS_PAL, scale: 3 },
];
const HERO_SCALE = 2;

export class HeroEngine {
  private ctx: CanvasRenderingContext2D;
  private scene: Scenery;
  private W = 320;
  private readonly H = 180;
  private t = 0;
  private last = 0;
  private raf = 0;
  private phase: Phase = 'intro';
  private wave = 0;
  private kills = 0;
  private mon: Monster | null = null;
  private shots: Shot[] = [];
  private parts: Particle[] = [];
  private cast = 0;
  private hurt = 0;
  private glow = 0;
  private shake = 0;
  private flash = 0;
  private flashColor = '#fff4e0';
  private hitstop = 0;
  private pending: Array<{ at: number; fn: () => void }> = [];
  private pointer = 0;
  private pan = 40;
  private wide = true;

  constructor(private canvas: HTMLCanvasElement, private emit: HeroEmit, private calm: boolean) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('no-2d');
    this.ctx = c;
    this.scene = new Scenery(this.W, this.H);
    if (calm) this.pan = 0;
  }

  /** 按舞台宽高比重算低清画布宽度（高恒 180），宽屏时勇者让出左侧给文案 */
  resize(cssW: number, cssH: number): void {
    const aspect = cssW / Math.max(1, cssH);
    this.W = Math.max(200, Math.min(520, Math.round(this.H * aspect)));
    this.wide = cssW >= 880;
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.scene.resize(this.W, this.H);
    if (this.mon) this.mon.tx = this.monX();
    this.draw();
  }

  private heroX(): number { return Math.round(this.W * (this.wide ? 0.55 : 0.2)); }
  private monX(): number { return Math.round(this.W * (this.wide ? 0.8 : 0.66)); }
  setPointer(xf: number): void { this.pointer = this.calm ? 0 : (xf - 0.5) * 12; }

  start(): void {
    this.last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop(): void { cancelAnimationFrame(this.raf); }

  /** 序章字幕播完（或被跳过）→ 开战 */
  begin(): void {
    this.phase = 'fight';
    this.wave = 0;
    this.kills = 0;
    this.pan = 0;
    this.spawn();
  }

  private spawn(): void {
    const w = WAVES[this.wave]!;
    this.mon = { kind: w.kind, x: this.W + 40, tx: this.monX(), hp: w.hp, max: w.hp, flash: 0, die: 0, lunge: 0, ready: false };
    if (this.calm) { this.mon.x = this.mon.tx; this.mon.ready = true; }
    this.report();
  }

  private busy(): boolean { return this.shots.length > 0 || !this.mon?.ready || this.mon.die > 0 || this.pending.length > 0; }

  private report(): void {
    const m = this.mon;
    this.emit.snap({ phase: this.phase, wave: this.wave, hp: m ? Math.max(0, m.hp) : 0, max: m?.max ?? 1, kills: this.kills, busy: this.busy(), ready: !!m?.ready });
  }

  /** 打出第 `card` 张词条卡；忙时拒绝（返回 false） */
  play(card: number): boolean {
    if (this.phase !== 'fight' || this.busy() || !this.mon) return false;
    const hx = this.heroX();
    const top = GROUND_Y - spriteSize(HERO_MAP, HERO_SCALE).h;
    const box = this.monBox();
    this.cast = 0.4;
    this.glow = 1;
    this.shots.push({ sx: hx + 24, sy: top + 16, tx: box.cx, ty: box.cy, t: 0, dur: this.calm ? 0.01 : 0.42, delay: this.calm ? 0 : 0.14, card });
    this.burst(hx + 24, top + 16, CARDS[card]!.color, 10, 50);
    this.report();
    return true;
  }

  private monBox(): { x: number; y: number; w: number; h: number; cx: number; cy: number } {
    const m = this.mon!;
    const s = SPR[m.kind]!;
    const { w, h } = spriteSize(s.map, s.scale);
    const bob = m.kind === 0 ? Math.round(Math.sin(this.t * 2.4) * 3) - 8 : 0;
    const x = Math.round(m.x - w / 2 - m.lunge * 30);
    const y = GROUND_Y - h + bob;
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  }

  private hit(card: number): void {
    const m = this.mon;
    if (!m) return;
    const correct = WAVES[this.wave]!.answer === card;
    const box = this.monBox();
    m.hp -= correct ? 1 : 0.25;
    m.flash = 0.18;
    const color = CARDS[card]!.color;
    this.burst(box.cx, box.cy, color, correct ? 46 : 14, correct ? 140 : 60);
    this.emit.pop(correct ? 'crit' : 'weak', box.cx / this.W, box.y / this.H);
    this.emit.impact(correct ? 'crit' : 'weak');
    if (!this.calm) {
      this.shake = correct ? 6 : 2;
      this.hitstop = correct ? 0.09 : 0;
      this.flash = correct ? 0.5 : 0;
      this.flashColor = color;
    }
    if (m.hp <= 0.001) {
      m.die = 0.001;
      this.kills++;
      this.emit.impact('kill');
      // 化作光点飞回勇者的词典：知识被吸收
      for (let i = 0; i < 60; i++) this.parts.push({ x: box.x + Math.random() * box.w, y: box.y + Math.random() * box.h, vx: (Math.random() - 0.5) * 80, vy: -Math.random() * 60, life: 0, max: 1.6, color: i % 3 ? color : '#ffe39a', size: 1 + (i % 2), home: true });
      this.later(0.9, () => this.emit.pop('loot', this.heroX() / this.W, 0.35));
      this.later(1.9, () => {
        this.mon = null;
        if (this.wave + 1 < WAVES.length) { this.wave++; this.spawn(); }
        else { this.phase = 'victory'; this.report(); }
      });
    } else if (!correct) {
      this.later(0.35, () => { if (this.mon) this.mon.lunge = 1; });
      this.later(0.55, () => {
        this.hurt = 0.35;
        this.emit.pop('hurt', this.heroX() / this.W, 0.45);
        this.emit.impact('hurt');
        if (!this.calm) { this.shake = 4; this.flash = 0.35; this.flashColor = '#8f1d24'; }
      });
    }
    this.report();
  }

  private later(sec: number, fn: () => void): void { this.pending.push({ at: this.t + (this.calm ? 0.01 : sec), fn }); }

  private burst(x: number, y: number, color: string, n: number, sp: number): void {
    if (this.calm) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = sp * (0.3 + Math.random() * 0.7);
      this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 20, life: 0, max: 0.4 + Math.random() * 0.5, color: i % 4 ? color : '#fff4e0', size: i % 3 ? 1 : 2 });
    }
  }

  private step(dt: number): void {
    if (this.hitstop > 0) { this.hitstop -= dt; return; }
    this.t += dt;
    this.cast = Math.max(0, this.cast - dt);
    this.hurt = Math.max(0, this.hurt - dt);
    this.glow = Math.max(0, this.glow - dt * 1.5);
    this.shake = Math.max(0, this.shake - dt * 22);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    if (this.phase === 'intro') this.pan = Math.max(0, this.pan - dt * 5);
    const due = this.pending.filter((p) => p.at <= this.t);
    this.pending = this.pending.filter((p) => p.at > this.t);
    due.forEach((p) => p.fn());
    if (due.length) this.report();
    const m = this.mon;
    if (m) {
      if (!m.ready) {
        m.x = Math.max(m.tx, m.x - dt * 70);
        if (m.x <= m.tx) { m.ready = true; this.report(); }
      }
      m.flash = Math.max(0, m.flash - dt);
      m.lunge = Math.max(0, m.lunge - dt * 3);
      if (m.die > 0) m.die += dt;
    }
    for (const s of this.shots) {
      if (s.delay > 0) { s.delay -= dt; continue; }
      s.t += dt;
      const p = this.shotPos(s);
      if (!this.calm) this.parts.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 20, vy: (Math.random() - 0.5) * 20, life: 0, max: 0.35, color: CARDS[s.card]!.color, size: 1 });
    }
    const landed = this.shots.filter((s) => s.delay <= 0 && s.t >= s.dur);
    this.shots = this.shots.filter((s) => !landed.includes(s));
    landed.forEach((s) => this.hit(s.card));
    this.ambient(dt);
    const hx = this.heroX() + 24;
    const hy = GROUND_Y - 18;
    for (const p of this.parts) {
      p.life += dt;
      if (p.home && p.life > 0.45) {
        p.vx += (hx - p.x) * dt * 9;
        p.vy += (hy - p.y) * dt * 9;
        p.vx *= 0.9; p.vy *= 0.9;
        if (Math.abs(hx - p.x) < 4 && Math.abs(hy - p.y) < 4) { p.life = p.max; this.glow = 1; }
      } else if (!p.home) p.vy += 40 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.parts = this.parts.filter((p) => p.life < p.max);
  }

  private shotPos(s: Shot): { x: number; y: number } {
    const k = Math.min(1, s.t / s.dur);
    return { x: s.sx + (s.tx - s.sx) * k, y: s.sy + (s.ty - s.sy) * k - Math.sin(Math.PI * k) * 22 };
  }

  /** 飘灰 + 火盆火星 */
  private ambient(dt: number): void {
    if (this.calm || this.parts.length > 260) return;
    if (Math.random() < dt * 14) this.parts.push({ x: Math.random() * this.W, y: -2, vx: 6 + Math.random() * 6, vy: 10 + Math.random() * 10, life: 0, max: 9, color: Math.random() > 0.5 ? '#4a3c44' : '#2e252c', size: 1 });
    if (Math.random() < dt * 8) this.parts.push({ x: this.braX() + (Math.random() - 0.5) * 6, y: GROUND_Y - 24, vx: (Math.random() - 0.5) * 10, vy: -20 - Math.random() * 20, life: 0, max: 1.4, color: Math.random() > 0.4 ? '#e0612b' : '#ffd27a', size: 1 });
  }
  private braX(): number { return this.heroX() - 34; }

  private draw(): void {
    const c = this.ctx;
    c.imageSmoothingEnabled = false;
    c.save();
    if (this.shake > 0) c.translate(Math.round((Math.random() - 0.5) * this.shake), Math.round((Math.random() - 0.5) * this.shake));
    const px = this.pointer + this.pan;
    this.scene.drawBack(c, this.t, px, Math.round(this.W * (this.wide ? 0.8 : 0.72)));
    this.scene.drawGround(c, px);
    const lights: Light[] = [this.scene.drawBrazier(c, this.braX() - Math.round(px * 0.9), this.t)];
    lights.push(...this.drawActors(c));
    for (const p of this.parts) {
      c.globalAlpha = Math.max(0, 1 - p.life / p.max);
      c.fillStyle = p.color;
      c.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    c.globalAlpha = 1;
    this.scene.drawFog(c, this.t * 1.4, GROUND_Y - 6, '#3a2630', 0.18);
    this.scene.drawLighting(c, lights, this.phase === 'intro' ? 0.72 : 0.58);
    if (this.flash > 0) {
      c.globalAlpha = this.flash * 0.5;
      c.fillStyle = this.flashColor;
      c.fillRect(-10, -10, this.W + 20, this.H + 20);
      c.globalAlpha = 1;
    }
    c.restore();
  }

  private drawActors(c: CanvasRenderingContext2D): Light[] {
    const lights: Light[] = [];
    const m = this.mon;
    if (m) {
      const s = SPR[m.kind]!;
      const b = this.monBox();
      const fade = m.die > 0 ? Math.max(0, 1 - m.die * 2.2) : 1;
      if (fade > 0) {
        drawSprite(c, s.map, s.pal, b.x, b.y, {
          scale: s.scale, flip: true, flash: m.flash > 0, alpha: fade,
          rowShift: (r) => (m.kind === 0 && r > 11 ? Math.round(Math.sin(this.t * 6 + r) * 1) : m.die > 0 ? Math.round((Math.random() - 0.5) * m.die * 8) : 0),
        });
        lights.push({ x: b.cx, y: b.y + b.h * 0.3, r: m.kind === 2 ? 26 : 14, power: 0.5 * fade });
      }
    }
    const hx = this.heroX() - (this.hurt > 0 ? 3 : 0);
    const { h } = spriteSize(HERO_MAP, HERO_SCALE);
    const breathe = Math.floor(this.t * 2) % 2;
    const hy = GROUND_Y - h + (this.cast > 0 ? -2 : breathe);
    // 红披风：随风阶梯摆动（Raksasi 式的一抹红）
    for (let i = 0; i < 9; i++) {
      const wy = Math.round(Math.sin(this.t * 5 - i * 0.7) * i * 0.45);
      c.fillStyle = i % 3 === 0 ? '#5a0f19' : '#9b1f2c';
      c.fillRect(hx + 8 - i * 3, hy + 14 + i + wy, 3, 2);
    }
    drawSprite(c, HERO_MAP, HERO_PAL, hx, hy, { scale: HERO_SCALE, flash: this.hurt > 0.25 });
    const tome = { x: hx + 24, y: hy + 18 };
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3);
    lights.push({ x: tome.x, y: tome.y, r: 22 + Math.round(pulse * 3) + Math.round(this.glow * 20), power: 0.9 });
    for (const s of this.shots) {
      if (s.delay > 0) continue;
      const p = this.shotPos(s);
      const col = CARDS[s.card]!.color;
      const spin = Math.floor(this.t * 12) % 2 === 0;
      drawSprite(c, spin ? RUNE_MAP : [...RUNE_MAP].reverse(), { x: col }, Math.round(p.x - 5), Math.round(p.y - 5), { scale: 2 });
      lights.push({ x: p.x, y: p.y, r: 20, power: 1 });
    }
    return lights;
  }
}
