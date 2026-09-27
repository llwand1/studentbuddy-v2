/**
 * continent-engine — 落地页「知识大陆」俯视演示的画布引擎（纯演出，不读写用户数据）。
 *
 * ★ 对应产品口径（KNOWLEDGE-CONTINENT-SPEC）：词条按顺序从中心 (0,0) 螺旋铺格；世界半径由词条数派生、
 *   只增不减（这里用"画布分辨率随半径阶梯变大"表现镜头拉远）；到期词条生成怪物并吞并地块，
 *   逾期越久吞得越多（上限 6 格）；英雄须走到怪物身边才开打——开打即交给横版遭遇战（`LandingHero`）。
 */
import { drawSprite } from '../hero/hero-sprites';
import { CHIBI_MAP, CHIBI_PAL, SHADE_MAP, SHADE_PAL, TILE_PAL, drawProp, drawSigil, drawTile } from './continent-art';
import { DEMO_TERMS } from './world-copy';
import type { Domain } from './world-copy';

export type ContinentSnap = { tiles: number; radius: number; occupied: number; monster: boolean; walking: boolean };
export type ContinentEmit = {
  snap: (s: ContinentSnap) => void;
  pop: (kind: 'term' | 'reclaim' | 'spread', idx: number, xf: number, yf: number) => void;
  encounter: () => void;
};

type Tile = { q: number; r: number; idx: number; domain: Domain; born: number; glow: number; bad: boolean };
type Dust = { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string };

const T = 14;
const TH = Math.round(T * 0.75);
const MAX_LANDS = 6;

/** 方形螺旋：中心 → 第 1 圈 8 格 → 第 2 圈 16 格 … */
export function spiral(count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[0, 0]];
  for (let k = 1; out.length < count; k++) {
    for (let q = -k; q <= k; q++) out.push([q, -k]);
    for (let r = -k + 1; r <= k; r++) out.push([k, r]);
    for (let q = k - 1; q >= -k; q--) out.push([q, k]);
    for (let r = k - 1; r > -k; r--) out.push([-k, r]);
  }
  return out.slice(0, count);
}
export const radiusOf = (n: number): number => (n <= 1 ? 0 : Math.ceil((Math.sqrt(n) - 1) / 2));

const SPIRAL = spiral(81);
const key = (q: number, r: number) => `${q},${r}`;

export class ContinentEngine {
  private c: CanvasRenderingContext2D;
  private dark = document.createElement('canvas');
  private W = 220;
  private H = 150;
  private t = 0;
  private last = 0;
  private raf = 0;
  private tiles = new Map<string, Tile>();
  private hero = { x: 0, y: 0, tx: 0, ty: 0 };
  private foe: { q: number; r: number; lands: string[] } | null = null;
  private dust: Dust[] = [];
  private walking = false;
  private radius = -1;

  constructor(private canvas: HTMLCanvasElement, private emit: ContinentEmit, private calm: boolean) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('no-2d');
    this.c = c;
    this.fit();
  }

  /** 半径变了才重设分辨率：世界越大，同一块屏幕里的像素越小＝镜头拉远 */
  private fit(): void {
    const R = radiusOf(this.tiles.size);
    if (R === this.radius) return;
    this.radius = R;
    const span = 2 * Math.max(R, 1) + 3;
    this.W = Math.max(span * T + 16, Math.round((span * TH + 24) / 0.6));
    this.H = Math.round(this.W * 0.6);
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.dark.width = this.W;
    this.dark.height = this.H;
  }

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

  private report(): void {
    this.emit.snap({ tiles: this.tiles.size, radius: radiusOf(this.tiles.size), occupied: this.foe?.lands.length ?? 0, monster: !!this.foe, walking: this.walking });
  }

  private screen(q: number, r: number): { x: number; y: number } {
    return { x: Math.round(this.W / 2 + q * T - T / 2), y: Math.round(this.H / 2 + r * TH - TH / 2) };
  }

  /** 学会一个词条：新地砖从天而降，落在螺旋的下一格 */
  learn(): void {
    const n = this.tiles.size;
    if (n >= SPIRAL.length || this.walking) return;
    const [q, r] = SPIRAL[n]!;
    const term = DEMO_TERMS[n % DEMO_TERMS.length]!;
    this.tiles.set(key(q, r), { q, r, idx: n, domain: term.domain, born: this.calm ? -9 : this.t, glow: 1, bad: false });
    this.fit();
    const p = this.screen(q, r);
    this.emit.pop('term', n % DEMO_TERMS.length, (p.x + T / 2) / this.W, p.y / this.H);
    this.report();
  }

  /** 时间流逝：没有怪就在远处生一只；已有则再吞一格（逾期越久占得越多） */
  decay(): void {
    if (this.walking || this.tiles.size < 5) return;
    if (!this.foe) {
      const far = [...this.tiles.values()].filter((t) => Math.abs(t.q) + Math.abs(t.r) >= 1 && !(t.q === this.hero.tx && t.r === this.hero.ty));
      const pick = far[far.length - 1 - (this.tiles.size % Math.max(1, Math.min(3, far.length)))] ?? far[0];
      if (!pick) return;
      this.foe = { q: pick.q, r: pick.r, lands: [] };
      this.corrupt(pick);
    } else if (this.foe.lands.length < MAX_LANDS) {
      const cand = [...this.tiles.values()].filter((t) => !t.bad && !(t.q === this.hero.tx && t.r === this.hero.ty))
        .sort((a, b) => (Math.abs(a.q - this.foe!.q) + Math.abs(a.r - this.foe!.r)) - (Math.abs(b.q - this.foe!.q) + Math.abs(b.r - this.foe!.r)));
      if (cand[0]) this.corrupt(cand[0]);
    }
    this.report();
  }

  private corrupt(t: Tile): void {
    t.bad = true;
    this.foe!.lands.push(key(t.q, t.r));
    const p = this.screen(t.q, t.r);
    this.puff(p.x + T / 2, p.y + TH / 2, '#8a2a6a', 12);
    this.emit.pop('spread', 0, (p.x + T / 2) / this.W, p.y / this.H);
  }

  /** 出发讨伐：走到怪物相邻格，抵达后交给遭遇战 */
  hunt(): void {
    const f = this.foe;
    if (!f || this.walking) return;
    const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dq, dr]) => this.tiles.get(key(f.q + dq!, f.r + dr!)))
      .filter((t): t is Tile => !!t)
      .sort((a, b) => Math.hypot(a.q - this.hero.x, a.r - this.hero.y) - Math.hypot(b.q - this.hero.x, b.r - this.hero.y))[0];
    const dest = adj ?? { q: f.q - 1, r: f.r };
    this.hero.tx = dest.q;
    this.hero.ty = dest.r;
    this.walking = true;
    if (this.calm) { this.hero.x = dest.q; this.hero.y = dest.r; }
    this.report();
  }

  /** 遭遇战胜利：解除占领，地块重新亮起 */
  cleanse(): void {
    const f = this.foe;
    if (!f) return;
    for (const k of f.lands) {
      const t = this.tiles.get(k);
      if (!t) continue;
      t.bad = false;
      t.glow = 1;
      const p = this.screen(t.q, t.r);
      this.puff(p.x + T / 2, p.y + TH / 2, '#ffe39a', 10);
    }
    const p = this.screen(f.q, f.r);
    this.emit.pop('reclaim', 0, (p.x + T / 2) / this.W, p.y / this.H);
    this.foe = null;
    this.report();
  }

  /** 点地图：点到怪/被占格 → 讨伐；点到普通格 → 走过去 */
  click(xf: number, yf: number): void {
    const x = xf * this.W;
    const y = yf * this.H;
    const q = Math.round((x - this.W / 2) / T);
    const r = Math.round((y - this.H / 2) / TH);
    const t = this.tiles.get(key(q, r));
    if (!t || this.walking) return;
    if (t.bad) { this.hunt(); return; }
    this.hero.tx = q;
    this.hero.ty = r;
    if (this.calm) { this.hero.x = q; this.hero.y = r; }
  }

  private puff(x: number, y: number, color: string, n: number): void {
    if (this.calm) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.dust.push({ x, y, vx: Math.cos(a) * 30, vy: Math.sin(a) * 18 - 10, life: 0, max: 0.5 + Math.random() * 0.4, color });
    }
  }

  private step(dt: number): void {
    this.t += dt;
    const h = this.hero;
    const dx = h.tx - h.x;
    const dy = h.ty - h.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.01) {
      const v = Math.min(d, dt * 4);
      h.x += (dx / d) * v;
      h.y += (dy / d) * v;
    } else if (this.walking) {
      h.x = h.tx;
      h.y = h.ty;
      this.walking = false;
      this.report();
      this.emit.encounter();
    }
    for (const t of this.tiles.values()) {
      t.glow = Math.max(0, t.glow - dt * 0.8);
      if (!this.calm && this.t - t.born > 0.4 && this.t - t.born < 0.4 + dt) {
        const p = this.screen(t.q, t.r);
        this.puff(p.x + T / 2, p.y + TH, '#8a7a66', 8);
      }
    }
    for (const p of this.dust) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 30 * dt; }
    this.dust = this.dust.filter((p) => p.life < p.max);
  }

  private draw(): void {
    const c = this.c;
    c.imageSmoothingEnabled = false;
    c.fillStyle = '#07060b';
    c.fillRect(0, 0, this.W, this.H);
    for (let i = 0; i < 40; i++) {
      const hsh = (i * 2654435761) >>> 0;
      c.fillStyle = i % 5 ? '#1a1522' : '#3a2e44';
      c.fillRect(hsh % this.W, (hsh >> 12) % this.H, 1, 1);
    }
    const list = [...this.tiles.values()].sort((a, b) => a.r - b.r || a.q - b.q);
    const fall = (t: Tile) => {
      const a = (this.t - t.born) / 0.4;
      return a >= 1 ? 0 : -Math.round((1 - Math.floor(a * 5) / 5) * 26);
    };
    for (const t of list) {
      const p = this.screen(t.q, t.r);
      const pal = t.bad ? TILE_PAL.corrupt : TILE_PAL[t.domain];
      drawTile(c, p.x, p.y + fall(t), T, pal, t.idx + 1, t.glow);
      if (t.bad && Math.floor(this.t * 4 + t.idx) % 3 === 0) {
        c.fillStyle = '#b04ac0';
        c.fillRect(p.x + ((t.idx * 5 + Math.floor(this.t * 3)) % (T - 2)), p.y + 2 + ((t.idx * 3) % (TH - 3)), 1, 1);
      }
    }
    // 竖立物按屏幕 y 排序：道具、怪物、英雄
    type Item = { y: number; draw: () => void };
    const items: Item[] = [];
    for (const t of list) {
      if (t.q === 0 && t.r === 0) continue;
      const p = this.screen(t.q, t.r);
      if (fall(t) === 0 && !(this.foe && t.q === this.foe.q && t.r === this.foe.r)) items.push({ y: p.y + TH - 3, draw: () => drawProp(c, p.x, p.y + TH - 3, ((t.idx + 1) * 2654435761 >>> 7) & 1023, t.domain, this.t) });
    }
    const f = this.foe;
    if (f) {
      const p = this.screen(f.q, f.r);
      const bob = Math.floor(this.t * 3) % 2;
      items.push({ y: p.y + TH, draw: () => {
        drawSigil(c, p.x + T / 2, p.y + TH / 2 + 1, 10 + Math.min(4, f.lands.length), this.t);
        drawSprite(c, SHADE_MAP, SHADE_PAL, p.x + 2, p.y - 6 - bob, { flip: true });
      } });
    }
    const hp = { x: this.W / 2 + this.hero.x * T - 4, y: this.H / 2 + this.hero.y * TH - 8 };
    const step = this.walking ? Math.floor(this.t * 8) % 2 : 0;
    items.push({ y: hp.y + 9, draw: () => drawSprite(c, CHIBI_MAP, CHIBI_PAL, Math.round(hp.x), Math.round(hp.y) - step, {}) });
    items.sort((a, b) => a.y - b.y).forEach((it) => it.draw());
    for (const p of this.dust) {
      c.globalAlpha = Math.max(0, 1 - p.life / p.max);
      c.fillStyle = p.color;
      c.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
    c.globalAlpha = 1;
    this.light(hp.x + 4, hp.y + 4);
  }

  /** 夜色：大陆之外沉入黑暗，英雄手里的词典照出一圈暖光（阶梯光斑，不用渐变） */
  private light(hx: number, hy: number): void {
    const d = this.dark.getContext('2d');
    if (!d) return;
    d.globalCompositeOperation = 'source-over';
    d.clearRect(0, 0, this.W, this.H);
    d.fillStyle = 'rgba(4,2,6,0.62)';
    d.fillRect(0, 0, this.W, this.H);
    d.globalCompositeOperation = 'destination-out';
    const R = (radiusOf(this.tiles.size) + 1.6) * T;
    const spots: Array<[number, number, number]> = [[this.W / 2, this.H / 2, R], [hx, hy, 26]];
    for (const [x, y, r0] of spots) {
      for (const [k, a] of [[1, 0.35], [0.75, 0.35], [0.5, 0.3]] as const) {
        const r = Math.round(r0 * k);
        d.fillStyle = `rgba(0,0,0,${a})`;
        for (let yy = -r; yy <= r; yy++) {
          const half = Math.floor(Math.sqrt(r * r - yy * yy) * 1.3);
          d.fillRect(Math.round(x - half), Math.round(y + yy * 0.8), half * 2 + 1, 1);
        }
      }
    }
    this.c.drawImage(this.dark, 0, 0);
  }
}
