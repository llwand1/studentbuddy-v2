/**
 * spell-fx-sheet.mts — 把魔法吟唱五款释放特效逐帧拼成一张接触印相（contact sheet），落 `docs/images/spell-fx-kinds.png`。
 *
 * ★ 不开浏览器：特效引擎只用 `fillRect` 这一小撮 API，`spell-fx-soft.ts` 的软件栅格器在纯 Node 里就能把帧画进
 *   RGBA 缓冲；PNG 用 `node:zlib` 现编（zlib + CRC32 + 三个 chunk），零新依赖。
 * ★ 为什么值得有它：五款 × 几十帧的编排靠脑补必错——本图是改动效时的"看样"，也是 PR / 契约 §8 里给评审看的实物。
 *   同 seed 逐帧确定 ⇒ 图可复现；改了编排就重跑本脚本、图随之变，评审对着 diff 看。
 *
 * 用法（仓库根）：`npx tsx tools/probes/spell-fx-sheet.mts [输出路径] [seed]`
 *   - 上五行 = 吟唱框里的释放特效，每款一行：8 个时间点（起手 / 蓄力 / 命中前一帧 / 命中帧 / 命中后一帧 /
 *     爆发 / 消散 / 收尾），时间点按各款自己的 `impactMs` / `durationMs` 取，不写死毫秒；
 *   - 下五行 = 同款在地图上的收复特效（`spell-burst.ts`，`SPELL_BURST_MS` 内均匀取 8 帧），画在一块 48px 的
 *     假地块上（中间一格 + 四邻淡格），坐标系与地图一致（`scale(3)`，16 单位/格）；
 *   - 低清帧 ×2 放大（最近邻，保硬边），底色用弹窗卡片色，左侧留一条款式色标。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SPELL_KINDS, SPELL_KIND_META } from '../../packages/shared/src/spell-kinds';
import { createSpellScene } from '../../packages/web/src/features/continent/spell-fx';
import { FX_PAL } from '../../packages/web/src/features/continent/spell-fx-art';
import { SPELL_BURST_MS, drawSpellBurst } from '../../packages/web/src/features/continent/spell-burst';
import { SoftCtx, asCtx, parseColor } from '../../packages/web/src/features/continent/spell-fx-soft';

const out = process.argv[2] ?? 'docs/images/spell-fx-kinds.png';
const seed = Number(process.argv[3] ?? 20260928);
const W = 176;
const H = 120;
const SCALE = 2;
const GAP = 6;
const BAR = 6;
const BG = '#120b12';
const CARD = '#1b1220';
/** 假地块：地图底 / 邻格 / 中间那格（近似 continent-canvas 的草地色阶，只为看特效衬不衬） */
const MAP_BG = '#101a12';
const MAP_NEAR = '#1d2f1f';
const MAP_TILE = '#2f4a2c';
const CELL = 48;
/** 上下两块之间多留一道缝 */
const BLOCK_GAP = GAP * 4;

const cols = 8;
const cellW = W * SCALE;
const cellH = H * SCALE;
const sheetW = GAP + BAR + GAP + cols * (cellW + GAP);
const sheetH = GAP + SPELL_KINDS.length * 2 * (cellH + GAP) + BLOCK_GAP;
const sheet = new Uint8Array(sheetW * sheetH * 4);

function fill(x0: number, y0: number, w: number, h: number, color: string): void {
  const [r, g, b] = parseColor(color);
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const i = (y * sheetW + x) * 4;
      sheet[i] = Math.round(r * 255);
      sheet[i + 1] = Math.round(g * 255);
      sheet[i + 2] = Math.round(b * 255);
      sheet[i + 3] = 255;
    }
  }
}

function blit(rgba: Uint8Array, x0: number, y0: number): void {
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const s = (y * W + x) * 4;
      for (let dy = 0; dy < SCALE; dy += 1) {
        for (let dx = 0; dx < SCALE; dx += 1) {
          const d = ((y0 + y * SCALE + dy) * sheetW + (x0 + x * SCALE + dx)) * 4;
          sheet[d] = rgba[s]!;
          sheet[d + 1] = rgba[s + 1]!;
          sheet[d + 2] = rgba[s + 2]!;
          sheet[d + 3] = 255;
        }
      }
    }
  }
}

fill(0, 0, sheetW, sheetH, BG);

const accent: Record<string, string> = {
  dusk: FX_PAL.dusk.bright,
  grace: FX_PAL.grace.amber,
  leaf: FX_PAL.leaf.pink,
  sylph: FX_PAL.sylph.green,
  salamander: FX_PAL.salamander.red,
};

SPELL_KINDS.forEach((kind, row) => {
  const meta = SPELL_KIND_META[kind];
  const times = [
    120,
    Math.round(meta.impactMs * 0.6),
    meta.impactMs - 67,
    meta.impactMs + 10,
    meta.impactMs + 77,
    meta.impactMs + 300,
    Math.round((meta.impactMs + meta.durationMs) / 2),
    meta.durationMs - 120,
  ];
  const y0 = GAP + row * (cellH + GAP);
  fill(GAP, y0, BAR, cellH, accent[kind]!);
  times.forEach((ms, col) => {
    const scene = createSpellScene(kind, seed, W, H);
    const soft = new SoftCtx(W, H);
    scene.draw(asCtx(soft), ms);
    blit(soft.toRGBA(CARD), GAP + BAR + GAP + col * (cellW + GAP), y0);
  });
  console.log(`${kind.padEnd(10)} ${meta.name}  帧@ms: ${times.join(', ')}`);
});

/** 地图版：在 W×H 的假地块上画收复特效（格中心 = 画布中心） */
function burstFrame(kind: (typeof SPELL_KINDS)[number], ms: number): SoftCtx {
  const soft = new SoftCtx(W, H);
  const ctx = asCtx(soft);
  const cx = Math.round(W / 2);
  const cy = Math.round(H / 2);
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, W, H);
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      ctx.fillStyle = dr === 0 && dc === 0 ? MAP_TILE : MAP_NEAR;
      ctx.fillRect(cx - CELL / 2 + dc * CELL + 1, cy - CELL / 2 + dr * CELL + 1, CELL - 2, CELL - 2);
    }
  }
  drawSpellBurst(ctx, cx, cy, ms, kind);
  return soft;
}

const burstTimes = [0, 67, 133, 267, 400, 533, 700, 850];
SPELL_KINDS.forEach((kind, row) => {
  const y0 = GAP + (SPELL_KINDS.length + row) * (cellH + GAP) + BLOCK_GAP;
  fill(GAP, y0, BAR, cellH, accent[kind]!);
  burstTimes.forEach((ms, col) => blit(burstFrame(kind, ms).toRGBA(MAP_BG), GAP + BAR + GAP + col * (cellW + GAP), y0));
});
console.log(`地图版 ${SPELL_KINDS.length} 款  帧@ms: ${burstTimes.join(', ')}（时长 ${SPELL_BURST_MS}）`);

/* ── PNG 编码（RGBA8，无滤波） ─────────────────────────────────── */
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const body = new Uint8Array(type.length + data.length);
  body.set(Buffer.from(type, 'ascii'));
  body.set(data, 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  return Buffer.concat([len, body, crc]);
}
const raw = new Uint8Array(sheetH * (sheetW * 4 + 1));
for (let y = 0; y < sheetH; y += 1) {
  raw[y * (sheetW * 4 + 1)] = 0;
  raw.set(sheet.subarray(y * sheetW * 4, (y + 1) * sheetW * 4), y * (sheetW * 4 + 1) + 1);
}
const ihdr = new Uint8Array(13);
const dv = new DataView(ihdr.buffer);
dv.setUint32(0, sheetW);
dv.setUint32(4, sheetH);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', new Uint8Array(0)),
]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`✓ ${out}  ${sheetW}×${sheetH}  ${(png.length / 1024).toFixed(0)} KB  seed=${seed}`);
