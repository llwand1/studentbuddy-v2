/**
 * learning/continent-world — 「玩家亲手开拓」的大陆存档与写口（规则见 `shared/continent-world.ts`）。
 *
 * ★ 存档落既有 `app_settings` 的 `continent_world` 键（与伙伴花名册 `npc_party` 同一先例：零新表）。
 * ★ 服务端只做**校验 + 记账**：这一格是不是迷雾边缘、开拓令够不够、那里是不是真有这只怪。
 *   刷怪位置、奖励格、建筑全部由 shared 纯函数现算——前端画的与这里校验的是同一份答案。
 */
import {
  bindTerms,
  cellKey,
  continentHash,
  detectBuildings,
  exploreCells,
  isFrontier,
  parseWorld,
  slayReward,
  speciesKey,
  tokensLeft,
  wildMonsters,
  type WorldSave,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { continentMap, type ContinentMapTerm } from './continent.js';

export const SETTING_KEY_WORLD = 'continent_world';

export type WorldResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export interface WorldPayload {
  world: WorldSave;
  termCount: number;
  /** 刷怪用的「今天」（UTC 天序号；前端必须用这个值算野怪，免得跨时区两边对不上） */
  day: number;
}

export function worldDay(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 86_400_000);
}

function seedFor(ownerId: string | null): number {
  return continentHash(`world|${ownerForWrite(ownerId)}`);
}

function readRaw(ownerId: string | null): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_WORLD) as { value: string } | undefined;
  return row ? row.value : null;
}

export function saveWorld(ownerId: string | null, world: WorldSave): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_WORLD, JSON.stringify(world));
}

/** 读存档并把空闲词条绑上荒地（有改动才回写）。同时把词条表带出去，调用方免得再查一次 */
export function loadWorld(ownerId: string | null): { world: WorldSave; terms: ContinentMapTerm[] } {
  const terms = continentMap(ownerId);
  const raw = readRaw(ownerId);
  const world = parseWorld(raw, seedFor(ownerId));
  if (bindTerms(world, terms.map((t) => t.id)) || raw === null) saveWorld(ownerId, world);
  return { world, terms };
}

export function worldPayload(ownerId: string | null): WorldPayload {
  const { world, terms } = loadWorld(ownerId);
  return { world, termCount: terms.length, day: worldDay() };
}

function cellOf(body: Record<string, unknown>): { row: number; col: number } | null {
  const row = Number(body.row);
  const col = Number(body.col);
  if (!Number.isInteger(row) || !Number.isInteger(col) || Math.abs(row) > 200 || Math.abs(col) > 200) return null;
  return { row, col };
}

/** 花 1 枚开拓令开一格迷雾（有怪的格必须先打） */
export function exploreOne(ownerId: string | null, body: Record<string, unknown>): WorldResult<WorldPayload & { fresh: Array<{ row: number; col: number }> }> {
  const at = cellOf(body);
  if (!at) return { ok: false, status: 400, error: '坐标不对' };
  const { world, terms } = loadWorld(ownerId);
  if (!isFrontier(world, at.row, at.col)) return { ok: false, status: 409, error: '只能开拓紧挨着你领土的迷雾格' };
  const day = worldDay();
  if (wildMonsters(world, terms.map((t) => t.id), day).some((m) => m.row === at.row && m.col === at.col)) {
    return { ok: false, status: 409, error: '那一格有怪守着——打败它，它身后的地会一起开出来' };
  }
  if (tokensLeft(world, terms.length, detectBuildings(world)) <= 0) {
    return { ok: false, status: 409, error: '开拓令用完了——多学几条词条（每条 +1），或者去打迷雾边上的怪' };
  }
  const fresh = exploreCells(world, [at]);
  world.spent += 1;
  bindTerms(world, terms.map((t) => t.id));
  saveWorld(ownerId, world);
  return { ok: true, world, termCount: terms.length, day, fresh };
}

/** 击败野怪：奖励一片地 + 记图鉴。`day` 允许是今天或昨天（跨零点那一刻打完的怪也要认） */
export function slayWild(ownerId: string | null, body: Record<string, unknown>): WorldResult<WorldPayload & { fresh: Array<{ row: number; col: number }>; species: string }> {
  const at = cellOf(body);
  if (!at) return { ok: false, status: 400, error: '坐标不对' };
  const today = worldDay();
  const day = Number(body.day);
  if (day !== today && day !== today - 1) return { ok: false, status: 409, error: '这只怪已经游荡走了，刷新一下地图' };
  const { world, terms } = loadWorld(ownerId);
  const mon = wildMonsters(world, terms.map((t) => t.id), day).find((m) => m.row === at.row && m.col === at.col);
  if (!mon) return { ok: false, status: 409, error: '那里已经没有怪了，刷新一下地图' };
  const fresh = exploreCells(world, slayReward(world, at));
  world.kills += 1;
  const key = speciesKey(mon.species);
  if (!world.codex.includes(key)) world.codex.push(key);
  bindTerms(world, terms.map((t) => t.id));
  saveWorld(ownerId, world);
  return { ok: true, world, termCount: terms.length, day: today, fresh, species: key };
}

/** 地块升级（追问问答全对之后由 `continent-delve.ts` 调用） */
export function levelUpCell(ownerId: string | null, row: number, col: number): WorldResult<WorldPayload & { lv: number }> {
  const { world, terms } = loadWorld(ownerId);
  const cell = world.cells[cellKey(row, col)];
  if (!cell) return { ok: false, status: 404, error: '这一格还没开拓' };
  cell.lv = Math.min(cell.lv + 1, 3);
  saveWorld(ownerId, world);
  return { ok: true, world, termCount: terms.length, day: worldDay(), lv: cell.lv };
}
