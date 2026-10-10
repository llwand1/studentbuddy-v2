/**
 * make-icon 的锁（`node --test tools/desktop/make-icon.test.mjs`，口径同 npm-package.test.mjs）。
 *
 * ★ 为什么值得锁：图标是**构建期从源码文本生成**的，它一旦读不到点阵/调色板就会静默退化
 *   （比如少一档尺寸、某档全透明），而那种图标要装到机器上才看得见 —— 与其靠眼睛，不如锁住
 *   「六档齐全」「确定可比」「读的就是 Mascot.tsx 那份点阵」这几条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICON_SIZES, buildIcon, buildRegionRuns, readSprite, resolveFill, renderSprite } from './make-icon.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MASCOT = fs.readFileSync(path.join(ROOT, 'packages/web/src/features/chat/Mascot.tsx'), 'utf8');

/** 按 ICO 头解析出六档尺寸 */
function icoSizes(ico) {
  assert.equal(ico.readUInt16LE(0), 0, 'reserved 应为 0');
  assert.equal(ico.readUInt16LE(2), 1, 'type 应为 1（icon）');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const w = ico[e] === 0 ? 256 : ico[e];
    sizes.push(w);
    const bytes = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    const png = ico.subarray(off, off + bytes);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `第 ${i} 档不是 PNG`);
  }
  return sizes;
}

test('点阵事实源：读的就是 Mascot.tsx 那份 16×16', () => {
  const sprite = readSprite(MASCOT);
  assert.equal(sprite.length, 16);
  for (const row of sprite) assert.equal(row.length, 16);
});

test('生成六档、每档都是合法 PNG 条目', () => {
  assert.deepEqual(icoSizes(buildIcon()), ICON_SIZES);
});

test('确定可比：同一份源码跑两次逐字节相同', () => {
  assert.deepEqual(buildIcon(), buildIcon());
});

test('非整数倍放大直接报错（像素图不许插值）', () => {
  const sprite = readSprite(MASCOT);
  assert.throws(() => renderSprite(sprite, { o: 'px-ink' }, { 'px-ink': [0, 0, 0] }, 17), /整数倍/);
});

test('外形矩形：条数 = 每行非空连续段之和，且不越出 16 格', () => {
  const sprite = readSprite(MASCOT);
  const runs = buildRegionRuns(sprite);
  const expected = sprite.reduce((n, row) => n + (row.match(/[^.]+/g) ?? []).length, 0);
  assert.equal(runs.length, expected);
  for (const r of runs) {
    assert.ok(r.x >= 0 && r.w >= 1 && r.x + r.w <= 16, `矩形越界：${JSON.stringify(r)}`);
    assert.ok(r.y >= 0 && r.y < 16);
  }
});

test('fill 表达式三种形态都能解析（var / color-mix / 字面色）', () => {
  const primary = [217, 67, 79];
  assert.deepEqual(resolveFill('var(--sb-primary)', primary), primary);
  assert.deepEqual(resolveFill('#ffffff', primary), [255, 255, 255]);
  // 58% 品牌色 + 42% 白：r=0.58*217+0.42*255=233
  assert.deepEqual(resolveFill('color-mix(in srgb, var(--sb-primary) 58%, #ffffff)', primary), [233, 146, 153]);
});