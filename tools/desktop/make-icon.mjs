#!/usr/bin/env node
/**
 * make-icon.mjs — 由**吉祥物点阵**生成 `app.ico`（零依赖，构建期跑）。
 *
 * ★ 为什么不在仓里存一张手画的图标：图标的唯一事实源是 `features/chat/Mascot.tsx` 里那份 16×16
 *   点阵与 `app.css` 里那五条由 `--sb-primary` 混出的调色板。存一张位图等于**抄了第二份**——
 *   以后换装（换帽子/改色）时图标不会跟着变，而这种漂移没人会去比对。本脚本改成**读源码文本**
 *  （手法同仓里 `card-pixel.test.ts` 读 CSS/组件文本的做法）：换装或改品牌色，重跑即同步。
 * ★ 只做像素级的最近邻放大（整数倍），不做插值：像素图的边缘必须硬，缩放糊边等于把画风改掉。
 * ★ 输出：16/32/48/64/128/256 六档 PNG 压进一个 ICO（Vista+ 支持 PNG 条目，Win10 全认）。
 *
 * 用法：node tools/desktop/make-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SPRITE_SRC = path.join(ROOT, 'packages/web/src/features/chat/Mascot.tsx');
const TOKENS_CSS = path.join(ROOT, 'packages/web/src/styles/tokens.css');
const APP_CSS = path.join(ROOT, 'packages/web/src/app/app.css');
const OUT = path.join(ROOT, 'tools/desktop/app.ico');
/** 吉祥物外形（网格单位的实心矩形）——宿主据此把球窗裁成吉祥物的形状 */
const REGION_OUT = path.join(ROOT, 'tools/desktop/mascot-region.txt');

/** 六档尺寸：16 的整数倍（16×k），保证每个点阵格都落在整像素上 */
export const ICON_SIZES = [16, 32, 48, 64, 128, 256];

/** 从 Mascot.tsx 抽出 SPRITE 的 16 行点阵（唯一事实源，不在这里抄一份） */
export function readSprite(text) {
  const block = /export const SPRITE\s*=\s*\[([\s\S]*?)\];/.exec(text);
  if (!block) throw new Error('Mascot.tsx 里找不到 SPRITE 点阵');
  const rows = [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  if (rows.length !== 16) throw new Error(`SPRITE 应为 16 行，实为 ${rows.length} 行`);
  rows.forEach((r, i) => {
    if (r.length !== 16) throw new Error(`SPRITE 第 ${i} 行宽 ${r.length}，应为 16`);
  });
  return rows;
}

/** 从 Mascot.tsx 抽出「点阵字母 → CSS 类名」的映射（CLS） */
export function readCls(text) {
  const block = /export const CLS[^{]*\{([\s\S]*?)\};/.exec(text);
  if (!block) throw new Error('Mascot.tsx 里找不到 CLS 映射');
  const map = {};
  for (const m of block[1].matchAll(/(\w)\s*:\s*'(px-\w+)'/g)) map[m[1]] = m[2];
  return map;
}

function hex(text) {
  const m = /^#([0-9a-f]{6})$/i.exec(text.trim());
  if (!m) throw new Error(`不是可解析的颜色：${text}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, p) {
  return [0, 1, 2].map((i) => Math.round(a[i] * p + b[i] * (1 - p)));
}

/** 解析 app.css 里那一句 fill 表达式（var() / color-mix() / 字面色），全在 --sb-primary 基础上算 */
export function resolveFill(expr, primary) {
  const e = expr.trim();
  if (/^var\(--sb-primary\)$/.test(e)) return primary;
  const cm = /^color-mix\(\s*in srgb,\s*var\(--sb-primary\)\s+(\d+)%\s*,\s*(#[0-9a-f]{6})\s*\)$/i.exec(e);
  if (cm) return mix(primary, hex(cm[2]), Number(cm[1]) / 100);
  return hex(e);
}

/** 从 tokens.css 取品牌色（--sb-primary） */
export function readPrimary(tokensCss) {
  const m = /--sb-primary:\s*(#[0-9a-f]{6})/i.exec(tokensCss);
  if (!m) throw new Error('tokens.css 里找不到 --sb-primary');
  return hex(m[1]);
}

/** 从 app.css 取五档调色板（类名 → RGB） */
export function readPalette(appCss, primary) {
  const palette = {};
  for (const cls of ['light', 'base', 'shade', 'ink', 'glint']) {
    const m = new RegExp(`\\.mascot-px\\s+\\.px-${cls}\\s*\\{[^}]*?fill:\\s*([^;]+);`).exec(appCss);
    if (!m) throw new Error(`app.css 里找不到 .px-${cls} 的 fill`);
    palette[`px-${cls}`] = resolveFill(m[1], primary);
  }
  return palette;
}

/** 把点阵按整数倍放大成 RGBA 位图（空像素透明） */
export function renderSprite(sprite, cls, palette, size) {
  const scale = size / sprite.length;
  if (!Number.isInteger(scale)) throw new Error(`尺寸 ${size} 不是 ${sprite.length} 的整数倍`);
  const rgba = Buffer.alloc(size * size * 4, 0);
  sprite.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const color = palette[cls[ch]];
      if (!color) throw new Error(`字母 "${ch}" 没有对应调色板`);
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((y * scale + dy) * size + x * scale + dx) * 4;
          rgba[o] = color[0];
          rgba[o + 1] = color[1];
          rgba[o + 2] = color[2];
          rgba[o + 3] = 255;
        }
      }
    });
  });
  return rgba;
}

/** 点阵 → 逐行合并的实心矩形（网格单位），供宿主按窗口 Region 抠出吉祥物**外形** */
export function buildRegionRuns(sprite) {
  const runs = [];
  sprite.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === '.') {
        x += 1;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w] !== '.') w += 1;
      runs.push({ x, y, w });
      x += w;
    }
  });
  return runs;
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 最小编码器：8 位 RGBA 真彩 PNG（只够本脚本用，不做通用实现） */
export function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 按 ICO 容器打包（PNG 条目；256 的宽高字节写 0） */
export function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((im) => {
    const e = Buffer.alloc(16);
    e[0] = im.size >= 256 ? 0 : im.size;
    e[1] = im.size >= 256 ? 0 : im.size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(im.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += im.png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/** 端到端：读源码 → 渲染六档 → 打包 ICO */
export function buildIcon() {
  const mascot = fs.readFileSync(SPRITE_SRC, 'utf8');
  const sprite = readSprite(mascot);
  const cls = readCls(mascot);
  const palette = readPalette(fs.readFileSync(APP_CSS, 'utf8'), readPrimary(fs.readFileSync(TOKENS_CSS, 'utf8')));
  const images = ICON_SIZES.map((size) => ({ size, png: encodePng(size, renderSprite(sprite, cls, palette, size)) }));
  return encodeIco(images);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--preview` = 额外落一张 256 的 PNG，便于人眼核对（.ico 本身看不了）
  const preview = process.argv.includes('--preview');
  const mascot = fs.readFileSync(SPRITE_SRC, 'utf8');
  const sprite = readSprite(mascot);
  const cls = readCls(mascot);
  const palette = readPalette(fs.readFileSync(APP_CSS, 'utf8'), readPrimary(fs.readFileSync(TOKENS_CSS, 'utf8')));
  const ico = encodeIco(ICON_SIZES.map((size) => ({ size, png: encodePng(size, renderSprite(sprite, cls, palette, size)) })));
  fs.writeFileSync(OUT, ico);
  const runs = buildRegionRuns(sprite);
  fs.writeFileSync(REGION_OUT, runs.map((r) => `${r.x} ${r.y} ${r.w}`).join('\n') + '\n');
  if (preview) {
    const previewPath = path.join(ROOT, '.runtime', 'icon-preview.png');
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    fs.writeFileSync(previewPath, encodePng(256, renderSprite(sprite, cls, palette, 256)));
    console.log(`  预览：${path.relative(ROOT, previewPath)}`);
  }
  console.log(`✓ 由吉祥物点阵生成 ${path.relative(ROOT, OUT)}（${ICON_SIZES.join('/')}，${ico.length} 字节）`);
  console.log(`✓ 吉祥物外形 ${path.relative(ROOT, REGION_OUT)}（${runs.length} 个矩形）`);
}