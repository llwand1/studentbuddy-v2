/** continent-layout: split domain module; compatible exports remain at continent.ts. */
import { WORLD_MAX_RADIUS } from './continent-core.js';
import { worldRadiusFor } from './continent-core.js';
import { WORLD_MIN_RADIUS } from './continent-core.js';
import type { ContinentTermLike } from './continent-core.js';
import type { ContinentTile } from './continent-core.js';
import { cellKey } from './continent-core.js';
import { spiralCells } from './continent-core.js';

// ── 钉住的地块（开拓制，2026-09-29）────────────────────────────────────────────
// 「点边界上的 +，答题，新地块**就长在点的那一格**」——这件事螺旋序做不到（螺旋只会把新词
// 放到下一个空位），所以开拓出来的词条要**记住坐标**。这是本文件头注口径 1（零新表）之内
// 唯一一份"存储的位置"：落既有 `app_settings` 的 `continent_pins` 键（精确到 `{ id, row, col }`），
// 与伙伴花名册（`npc_party`）同一条路，不建表、不加列。
// ★ 钉子只对**有词条**的 id 生效：词条删了，钉子自然作废（那一格重新空出来），不必清理。
// ★ 没钉的词条仍走螺旋，**跳过被钉住的格**：钉子只在当时的空格上打（服务端校验），
//   故已落位的螺旋格永远不会被钉子挤走——"加词不挪旧格"这条不破。

/** `app_settings` 里的键（按 owner 一行；值 = `{ pins: ContinentPin[] }`） */
export const SETTING_KEY_CONTINENT_PINS = 'continent_pins';

/** 一枚钉子：词条 `id` 固定在世界坐标 `(row, col)` */
export interface ContinentPin {
  id: string;
  row: number;
  col: number;
}

/** 解析落库原文（容错：坏 JSON / 非整数坐标 / 重复 id 一律丢弃，不因一行坏数据丢整份） */
export function parseContinentPins(raw: string | null | undefined): ContinentPin[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  const list = value && typeof value === 'object' ? (value as { pins?: unknown }).pins : null;
  if (!Array.isArray(list)) return [];
  const out: ContinentPin[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    const row = Number(p.row);
    const col = Number(p.col);
    if (!id || seen.has(id) || !Number.isInteger(row) || !Number.isInteger(col)) continue;
    if (Math.abs(row) > WORLD_MAX_RADIUS || Math.abs(col) > WORLD_MAX_RADIUS) continue;
    seen.add(id);
    out.push({ id, row, col });
  }
  return out;
}

/** 落库形状（与 `parseContinentPins` 互逆） */
export function serializeContinentPins(pins: readonly ContinentPin[]): string {
  return JSON.stringify({ pins: pins.map((p) => ({ id: p.id, row: p.row, col: p.col })) });
}

/**
 * 世界半径 = `max(worldRadiusFor(n + 1), 最远钉子 + 1)`，再夹到 `[MIN, MAX]`。
 *
 * ★ 为什么是 `n + 1` 而不是 `n`：世界要**永远留着下一块地的位置**——边界上的「+」才有处落脚。
 *   `worldRadiusFor` 在 `n = (2R+1)²` 时恰好铺满，那一刻没有任何空格可点，开拓就成了死路。
 *   `sqrt` 单调 ⇒ 仍然只增不减；螺旋序列是稳定前缀 ⇒ 半径多一圈不会挪动任何已落位的格。
 * ★ 为什么钉子要 `+ 1`：往外开拓到当前边界时，它外面那一圈必须出现在世界里，
 *   否则"开疆"到边就停了。钉子只会越钉越远（词条删了才会缩回来，而缩回来不挪任何格）。
 */
export function layoutRadius(termCount: number, pins: readonly ContinentPin[] = []): number {
  let need = worldRadiusFor(Math.max(0, Math.trunc(termCount) || 0) + 1);
  for (const p of pins) need = Math.max(need, Math.abs(p.row) + 1, Math.abs(p.col) + 1);
  return Math.min(Math.max(need, WORLD_MIN_RADIUS), WORLD_MAX_RADIUS);
}

/**
 * 把词条铺进大陆：`created_at` 升序（同值按 id）⇒ 螺旋次序（中心 `(0,0)` 起）；
 * **有钉子的词条落在钉子上**，没钉子的按序填**没被钉住的**螺旋格。
 *
 * ★★ 半径**由本函数自己现算**（`layoutRadius(terms.length, pins)`）：单一入口——
 *   调用方传半径就可能传出"比实际需要小"的值，那会静默截断词条（旧版 140 格截断的教训）。
 * ★ 仍保留"铺不下就停"这一条，但只在**词条数超过 `WORLD_MAX_RADIUS` 容量（6561）**时才可能触发；
 *   正常量级（≤500）永远铺得下 ⇒ 旧横幅「另有 N 条词条暂未铺上图」已删（不再有那种情况）。
 * ★ 输出仍按 `created_at` 序（钉住的也混在其中）：调用方拿下标做"长出来"的错峰与英雄起点，
 *   与钉不钉无关。
 * ★ 钉子的容错在这里兜底：id 不在词条里（词条已删）、同一格两枚（不该发生，服务端已校验）
 *   ⇒ 后者作废走螺旋。宁可多铺一格螺旋，也不让两条词条叠在一格上。
 */
export function layoutTiles<T extends ContinentTermLike>(
  terms: readonly T[],
  pins: readonly ContinentPin[] = [],
): Array<ContinentTile<T>> {
  const known = new Set(terms.map((t) => t.id));
  const pinOf = new Map<string, ContinentPin>();
  const pinned = new Set<string>();
  for (const p of pins) {
    const key = cellKey(p.row, p.col);
    if (!known.has(p.id) || pinOf.has(p.id) || pinned.has(key)) continue;
    pinOf.set(p.id, p);
    pinned.add(key);
  }
  const cells = spiralCells(layoutRadius(terms.length, [...pinOf.values()])).filter(
    (c) => !pinned.has(cellKey(c.row, c.col)),
  );
  const sorted = [...terms].sort((a, b) => {
    const ka = `${a.created_at ?? ''}\u0000${a.id}`;
    const kb = `${b.created_at ?? ''}\u0000${b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const out: Array<ContinentTile<T>> = [];
  let next = 0;
  for (const term of sorted) {
    const pin = pinOf.get(term.id);
    if (pin) {
      out.push({ term, row: pin.row, col: pin.col });
      continue;
    }
    const cell = cells[next];
    if (!cell) break;
    next += 1;
    out.push({ term, row: cell.row, col: cell.col });
  }
  return out;
}
