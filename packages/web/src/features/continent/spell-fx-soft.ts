/**
 * spell-fx-soft — 软件栅格器：`CanvasRenderingContext2D` 里释放特效用到的那一小撮（`fillRect` / 平移 / 等比缩放 /
 * 透明度 / `difference` / `destination-out`），在纯 Node 里把一帧真的画进 RGBA 缓冲。
 *
 * ★ 为什么要有它：jsdom 没有 canvas，而"负片帧真的整屏发白""目标在消散末帧真的没了""一款只用自己的调色板"
 *   这些断言**必须看像素**才成立——录 `fillRect` 调用只能证明"画了"，证明不了"画对了"。
 *   `tools/probes/spell-fx-sheet.mts` 也用它把五款逐帧拼成接触印相（docs/images/spell-fx-kinds.png），
 *   不开浏览器就能核对每一帧长什么样。
 * ★ 只实现引擎用到的子集；其它属性/方法一律不存在——引擎若偷偷用了 `arc()`，测试当场 TypeError（这正是想要的）。
 */
export type SoftOp = 'source-over' | 'source-in' | 'destination-over' | 'difference' | 'destination-out';

export class SoftCtx {
  /** 非预乘 RGBA，每通道 0–1 */
  readonly buf: Float32Array;
  fillStyle = '#000000';
  globalAlpha = 1;
  globalCompositeOperation: SoftOp = 'source-over';
  imageSmoothingEnabled = false;
  /** 录像：每次 fillRect 用到的颜色（调色板纪律断言用） */
  readonly colors = new Set<string>();
  private tx = 0;
  private ty = 0;
  private sx = 1;
  private sy = 1;
  private stack: Array<[number, number, number, number]> = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.buf = new Float32Array(width * height * 4);
  }

  save(): void {
    this.stack.push([this.tx, this.ty, this.sx, this.sy]);
  }

  restore(): void {
    const top = this.stack.pop();
    if (top) [this.tx, this.ty, this.sx, this.sy] = top;
  }

  translate(x: number, y: number): void {
    this.tx += x * this.sx;
    this.ty += y * this.sy;
  }

  /** 地图版特效用 `scale(3, 3)` 把 16 单位/格的坐标放大成 48px 的格 */
  scale(x: number, y: number): void {
    this.sx *= x;
    this.sy *= y;
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.each(x, y, w, h, (i) => {
      this.buf[i] = 0;
      this.buf[i + 1] = 0;
      this.buf[i + 2] = 0;
      this.buf[i + 3] = 0;
    });
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const [sr, sg, sb, sa0] = parseColor(this.fillStyle);
    const sa = sa0 * this.globalAlpha;
    this.colors.add(this.fillStyle.toLowerCase());
    const op = this.globalCompositeOperation;
    this.each(x, y, w, h, (i) => {
      const b = this.buf;
      const da = b[i + 3]!;
      if (op === 'destination-out') {
        b[i + 3] = da * (1 - sa);
        return;
      }
      if (op === 'source-in') {
        b[i] = sr;
        b[i + 1] = sg;
        b[i + 2] = sb;
        b[i + 3] = sa * da;
        return;
      }
      if (op === 'destination-over') {
        const oa = da + sa * (1 - da);
        if (oa <= 0) return;
        b[i] = (b[i]! * da + sr * sa * (1 - da)) / oa;
        b[i + 1] = (b[i + 1]! * da + sg * sa * (1 - da)) / oa;
        b[i + 2] = (b[i + 2]! * da + sb * sa * (1 - da)) / oa;
        b[i + 3] = oa;
        return;
      }
      const src: [number, number, number] = op === 'difference' && da > 0 ? [Math.abs(sr - b[i]!), Math.abs(sg - b[i + 1]!), Math.abs(sb - b[i + 2]!)] : [sr, sg, sb];
      const oa = sa + da * (1 - sa);
      if (oa <= 0) return;
      for (let ch = 0; ch < 3; ch += 1) b[i + ch] = (src[ch]! * sa + b[i + ch]! * da * (1 - sa)) / oa;
      b[i + 3] = oa;
    });
  }

  /** 某像素的 RGBA（0–1）；越界返回全 0 */
  at(x: number, y: number): [number, number, number, number] {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.buf[i]!, this.buf[i + 1]!, this.buf[i + 2]!, this.buf[i + 3]!];
  }

  /** 区域里不透明像素的占比与平均亮度（断言"发白""空了"用） */
  stats(x0 = 0, y0 = 0, w = this.width, h = this.height): { coverage: number; luma: number } {
    let n = 0;
    let lit = 0;
    let luma = 0;
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x += 1) {
        const [r, g, b, a] = this.at(x, y);
        n += 1;
        if (a > 0.05) {
          lit += 1;
          luma += (0.299 * r + 0.587 * g + 0.114 * b) * a;
        }
      }
    }
    return { coverage: n ? lit / n : 0, luma: lit ? luma / lit : 0 };
  }

  /** 拍平成 8-bit RGBA（叠在 `bg` 之上；探针写 PNG 用） */
  toRGBA(bg: string): Uint8Array {
    const [br, bgc, bb] = parseColor(bg);
    const out = new Uint8Array(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i += 1) {
      const a = this.buf[i * 4 + 3]!;
      const src = [this.buf[i * 4]!, this.buf[i * 4 + 1]!, this.buf[i * 4 + 2]!];
      const dst = [br, bgc, bb];
      for (let ch = 0; ch < 3; ch += 1) out[i * 4 + ch] = Math.round((src[ch]! * a + dst[ch]! * (1 - a)) * 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  private each(x: number, y: number, w: number, h: number, fn: (i: number) => void): void {
    const x0 = Math.max(0, Math.round(x * this.sx + this.tx));
    const y0 = Math.max(0, Math.round(y * this.sy + this.ty));
    const x1 = Math.min(this.width, Math.round((x + w) * this.sx + this.tx));
    const y1 = Math.min(this.height, Math.round((y + h) * this.sy + this.ty));
    for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) fn((yy * this.width + xx) * 4);
  }
}

/** `#rgb` / `#rrggbb` / `rgba(r,g,b,a)` → [r,g,b,a]（0–1）；认不出的当不透明黑 */
export function parseColor(s: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (hex) {
    const v = hex[1]!;
    const full = v.length === 3 ? [...v].map((c) => c + c).join('') : v;
    return [parseInt(full.slice(0, 2), 16) / 255, parseInt(full.slice(2, 4), 16) / 255, parseInt(full.slice(4, 6), 16) / 255, 1];
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(s.trim());
  if (rgba) {
    const parts = rgba[1]!.split(',').map((p) => parseFloat(p));
    return [(parts[0] ?? 0) / 255, (parts[1] ?? 0) / 255, (parts[2] ?? 0) / 255, parts[3] ?? 1];
  }
  return [0, 0, 0, 1];
}

/** 当成真 ctx 用（引擎签名收 `CanvasRenderingContext2D`；越出子集就 TypeError） */
export function asCtx(soft: SoftCtx): CanvasRenderingContext2D {
  return soft as unknown as CanvasRenderingContext2D;
}
