/**
 * hero-scene — 序章舞台的布景层：天空色带、血月、远景教堂废墟、中景断柱枯树、雾带、地面、火盆与光照。
 *
 * ★ 全部按 **整数像素** 在低分辨率画布（高 180px）上绘制，再由 CSS `image-rendering: pixelated`
 *   放大——所以边缘永远是硬的方块，不会出现平滑缓动或抗锯齿渐变。
 * ★ 光照模仿 There Is No Light 的"黑暗吞没 + 暖光源挖洞"：先铺一层暗幕，
 *   再按**三档阶梯**同心圆挖出光斑（不用径向渐变，避免破坏像素感）。
 */
export const GROUND_Y = 150;

export type Light = { x: number; y: number; r: number; power?: number };

/** 固定种子伪随机：布景每次打开都长一个样，不因刷新跳版 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Spire = { x: number; w: number; h: number; tip: number; win: boolean };
type Prop = { x: number; kind: 'pillar' | 'tree' | 'grave' | 'sword'; h: number };

export class Scenery {
  private spires: Spire[] = [];
  private props: Prop[] = [];
  private dark: HTMLCanvasElement;
  private dctx: CanvasRenderingContext2D | null;

  constructor(private w: number, private h: number) {
    this.dark = document.createElement('canvas');
    this.dctx = this.dark.getContext('2d');
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.dark.width = w;
    this.dark.height = h;
    const r = rng(7);
    this.spires = [];
    for (let x = -20; x < w + 40; ) {
      const sw = 8 + Math.floor(r() * 18);
      this.spires.push({ x, w: sw, h: 22 + Math.floor(r() * 46), tip: 4 + Math.floor(r() * 14), win: r() > 0.72 });
      x += sw + Math.floor(r() * 6);
    }
    const r2 = rng(19);
    this.props = [];
    for (let x = -10; x < w + 30; x += 26 + Math.floor(r2() * 40)) {
      const k = r2();
      this.props.push({ x, kind: k < 0.3 ? 'pillar' : k < 0.55 ? 'tree' : k < 0.85 ? 'grave' : 'sword', h: 10 + Math.floor(r2() * 30) });
    }
  }

  /** 天空 + 血月 + 远景 + 中景（px 为鼠标视差偏移，单位低清像素） */
  drawBack(ctx: CanvasRenderingContext2D, t: number, px: number, moonX: number): void {
    const bands = ['#040306', '#07050a', '#0b070d', '#110a10', '#180c12', '#221016', '#2c1318'];
    const bh = Math.ceil(GROUND_Y / bands.length);
    bands.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(0, i * bh, this.w, bh + 1);
      // 色带交界处做 2 行棋盘抖动：像素画的"渐变"
      if (i > 0) {
        ctx.fillStyle = bands[i - 1]!;
        for (let x = 0; x < this.w; x += 2) ctx.fillRect(x + (i % 2), i * bh, 1, 1);
      }
    });
    // 星尘
    const r = rng(3);
    for (let i = 0; i < 60; i++) {
      const sx = Math.floor(r() * this.w);
      const sy = Math.floor(r() * 90);
      if ((Math.floor(t * 2 + i) % 9) === 0) continue;
      ctx.fillStyle = r() > 0.8 ? '#6b5a66' : '#3a2e38';
      ctx.fillRect(sx, sy, 1, 1);
    }
    this.drawMoon(ctx, moonX - px * 0.1, 46, t);
    // 远景废墟
    ctx.fillStyle = '#120a10';
    const off = px * 0.25;
    for (const s of this.spires) {
      const top = GROUND_Y - 18 - s.h;
      const x = Math.round(s.x - off);
      ctx.fillRect(x, top, s.w, s.h + 20);
      for (let i = 0; i < s.tip; i++) {
        const iw = Math.max(1, Math.round(s.w * (1 - i / s.tip)));
        ctx.fillRect(x + Math.round((s.w - iw) / 2), top - i, iw, 1);
      }
      if (s.win) {
        ctx.fillStyle = Math.floor(t * 1.3 + s.x) % 7 === 0 ? '#5a1a1a' : '#3a1214';
        ctx.fillRect(x + Math.floor(s.w / 2) - 1, top + 6, 2, 4);
        ctx.fillStyle = '#120a10';
      }
    }
    this.drawFog(ctx, t, GROUND_Y - 34, '#2a1a24', 0.22);
    // 中景道具
    const off2 = px * 0.55;
    for (const p of this.props) this.drawProp(ctx, p, Math.round(p.x - off2));
  }

  private drawMoon(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number): void {
    const R = 22;
    const pulse = Math.floor(t * 1.5) % 2;
    const rings: Array<[number, string]> = [[R + 14 + pulse, '#1f0c10'], [R + 8, '#2c0f14'], [R + 3, '#44141a']];
    for (const [rr, c] of rings) this.disc(ctx, cx, cy, rr, c, true);
    this.disc(ctx, cx, cy, R, '#8a1c22', false);
    this.disc(ctx, cx - 4, cy - 4, R - 6, '#a8262c', false);
    ctx.fillStyle = '#6c141a';
    for (const [dx, dy, s] of [[6, 4, 4], [-8, 8, 3], [2, -10, 2], [10, -4, 2]] as const) ctx.fillRect(cx + dx, cy + dy, s, s);
  }

  /** 实心或棋盘抖动的整数圆 */
  private disc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, dither: boolean): void {
    ctx.fillStyle = color;
    for (let y = -r; y <= r; y++) {
      const half = Math.floor(Math.sqrt(r * r - y * y));
      if (!dither) ctx.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1);
      else for (let x = -half; x <= half; x++) if ((x + y) % 2 === 0) ctx.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
    }
  }

  private drawProp(ctx: CanvasRenderingContext2D, p: Prop, x: number): void {
    const g = GROUND_Y;
    ctx.fillStyle = '#0a0609';
    if (p.kind === 'pillar') {
      ctx.fillRect(x, g - p.h - 6, 9, p.h + 6);
      ctx.fillRect(x - 2, g - p.h - 8, 13, 3);
      ctx.fillRect(x + 7, g - p.h - 12, 4, 4); // 断口
    } else if (p.kind === 'tree') {
      ctx.fillRect(x + 3, g - p.h - 10, 3, p.h + 10);
      ctx.fillRect(x - 4, g - p.h - 4, 8, 2);
      ctx.fillRect(x + 5, g - p.h + 2, 9, 2);
      ctx.fillRect(x - 6, g - p.h - 7, 3, 3);
      ctx.fillRect(x + 12, g - p.h, 2, -4);
    } else if (p.kind === 'grave') {
      ctx.fillRect(x, g - 11, 8, 11);
      ctx.fillRect(x + 1, g - 13, 6, 2);
      ctx.fillStyle = '#1a1016';
      ctx.fillRect(x + 3, g - 10, 2, 6);
      ctx.fillRect(x + 1, g - 8, 6, 2);
    } else {
      ctx.fillRect(x + 2, g - 16, 2, 16);
      ctx.fillRect(x, g - 13, 6, 2);
      ctx.fillStyle = '#3a2c32';
      ctx.fillRect(x + 2, g - 16, 1, 3);
    }
  }

  drawFog(ctx: CanvasRenderingContext2D, t: number, y: number, color: string, alpha: number): void {
    ctx.fillStyle = color;
    for (let i = 0; i < 6; i++) {
      ctx.globalAlpha = alpha * (1 - i / 7);
      const drift = Math.round(Math.sin(t * 0.3 + i) * 18 + t * (4 + i));
      for (let x = -40; x < this.w + 40; x += 48) {
        const xx = ((x + drift) % (this.w + 80)) - 40;
        ctx.fillRect(Math.round(xx), y + i * 3, 30 + ((i * 7) % 14), 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawGround(ctx: CanvasRenderingContext2D, px: number): void {
    const g = GROUND_Y;
    ctx.fillStyle = '#0b0709';
    ctx.fillRect(0, g, this.w, this.h - g);
    ctx.fillStyle = '#24161b';
    ctx.fillRect(0, g, this.w, 1);
    const off = Math.round(px * 0.9);
    for (let x = -off % 16 - 16; x < this.w; x += 16) {
      ctx.fillStyle = '#160d11';
      ctx.fillRect(x, g + 1, 15, 5);
      ctx.fillStyle = '#1d1216';
      ctx.fillRect(x + 1, g + 1, 13, 1);
      ctx.fillStyle = '#0f090c';
      ctx.fillRect(x + 8, g + 8, 12, 4);
    }
  }

  /** 火盆：石座 + 逐帧跳动的三层火舌；返回光源供光照层挖洞 */
  drawBrazier(ctx: CanvasRenderingContext2D, x: number, t: number): Light {
    const g = GROUND_Y;
    ctx.fillStyle = '#1a1114';
    ctx.fillRect(x - 2, g - 12, 5, 12);
    ctx.fillRect(x - 6, g - 15, 13, 3);
    ctx.fillStyle = '#2d1e22';
    ctx.fillRect(x - 6, g - 15, 13, 1);
    const f = Math.floor(t * 10) % 3;
    const layers: Array<[string, number, number]> = [['#8f1d24', 5, 9 + f], ['#e0612b', 3, 6 + ((f + 1) % 3)], ['#ffd27a', 1, 3 + ((f + 2) % 2)]];
    for (const [c, hw, hh] of layers) {
      ctx.fillStyle = c;
      ctx.fillRect(x - hw, g - 15 - hh, hw * 2 + 1, hh);
    }
    return { x, y: g - 20, r: 34 + f };
  }

  /** 暗幕 + 阶梯光斑。darkness 0..1 */
  drawLighting(ctx: CanvasRenderingContext2D, lights: Light[], darkness: number): void {
    const d = this.dctx;
    if (!d) return;
    d.globalCompositeOperation = 'source-over';
    d.clearRect(0, 0, this.w, this.h);
    d.fillStyle = `rgba(3,1,4,${darkness})`;
    d.fillRect(0, 0, this.w, this.h);
    d.globalCompositeOperation = 'destination-out';
    for (const L of lights) {
      const pw = L.power ?? 1;
      for (const [k, a] of [[1, 0.35], [0.7, 0.35], [0.42, 0.4]] as const) {
        d.fillStyle = `rgba(0,0,0,${a * pw})`;
        const r = Math.round(L.r * k);
        for (let y = -r; y <= r; y += 1) {
          const half = Math.floor(Math.sqrt(r * r - y * y));
          d.fillRect(Math.round(L.x - half), Math.round(L.y + y), half * 2 + 1, 1);
        }
      }
    }
    ctx.drawImage(this.dark, 0, 0);
  }
}
