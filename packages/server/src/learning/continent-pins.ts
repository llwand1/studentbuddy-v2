/**
 * learning/continent-pins — 开拓出来的地块**钉在哪一格**（契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「开拓」）。
 *
 * ★★ **零迁移**：钉子落既有 `app_settings` 的 `continent_pins` 键（按 owner 一行，值 = `{ pins: [{ id, row, col }] }`），
 *   与伙伴花名册（`npc_party`）同一条路——不建表、不加列、不加索引。
 *   形状与解析都在 `@sb/shared`（`parseContinentPins` / `serializeContinentPins`）：前端拿到的就是这份原样。
 * ★ 钉子**只增**：词条删了钉子留着也无害（`layoutTiles` 只认有词条的 id），故这里没有"删钉子"的写口。
 *   代价是这一行会慢慢长（一条钉子约 60 字节；开拓 500 块也不过 30 KB），换来的是不必在删词条那条路上多挂一个钩子。
 * ★ 归属：读写都带 `owner_id`（`ownerForWrite(null)` ⇒ `''` = 无主行），主键是 `(owner_id, key)`。
 */
import { SETTING_KEY_CONTINENT_PINS, parseContinentPins, serializeContinentPins, type ContinentPin } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/** 本用户全部钉子（容错解析：坏行当作没有） */
export function loadContinentPins(ownerId: string | null): ContinentPin[] {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_CONTINENT_PINS) as { value: string } | undefined;
  return parseContinentPins(row?.value);
}

/**
 * 追加一枚钉子（同一 id 已有 ⇒ 覆盖坐标；同一格已有别的钉子 ⇒ 由调用方在开拓校验里拦，这里不再判）。
 * ★ 读-改-写放在一个事务里：两次开拓并发落在同一毫秒也不会互相覆盖掉对方的钉子。
 */
export function saveContinentPin(ownerId: string | null, pin: ContinentPin): ContinentPin[] {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  return db.transaction(() => {
    const pins = loadContinentPins(ownerId).filter((p) => p.id !== pin.id);
    pins.push({ id: pin.id, row: pin.row, col: pin.col });
    db.prepare(
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    ).run(owner, SETTING_KEY_CONTINENT_PINS, serializeContinentPins(pins));
    return pins;
  })();
}
