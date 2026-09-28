/**
 * learning/ember — 「余烬笺 · 意外发现」（2026-09-28，兑现首页第二章「荒野里的异火」）。
 *
 * 玩法：
 *   - **写笺**：给自己的一条词条写一段自己的理解并署名（显式动作＝同意公开）。
 *   - **遇火**：每个本地日，你的大陆上会在一块随机的词条地上燃起一簇异色篝火，里面是**别的玩家**写的一张笺；
 *     走近即可读。同一天内位置与内容稳定（按 owner + 日 + 笺 id 散列），「过一夜」就换一簇。
 *   - **收入卡册**：把那条词条加进自己的库（已有同名词条则不覆盖你的释义）。
 *   - **添柴致谢**：每人对每张笺只算一次；作者在「我的余烬笺」里能看到被谢了几次。
 *   - **不想再看 / 举报**：先对自己下线（hidden），不影响别人。
 * ★ 不回读邮箱等账号信息：署名由作者自己写（默认用昵称，没有昵称就是「无名旅人」）。
 */
import { randomUUID } from 'node:crypto';
import { continentHash, localDayKey } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { scanMap } from './npc-map.js';
import { saveOneTerm, buildTermIndex } from './terms.js';

export const EMBER_BODY_MIN = 8;
export const EMBER_BODY_MAX = 200;
export const EMBER_SIGN_MAX = 12;
export const EMBER_HUES = ['cyan', 'violet', 'gold', 'green'] as const;

export interface EmberNoteView {
  id: string;
  term: string;
  domain: string;
  definition: string;
  body: string;
  sign: string;
  hue: string;
  thanks: number;
  createdAt: string;
}

export interface EmberSpot {
  note: EmberNoteView;
  row: number;
  col: number;
  kept: boolean;
  thanked: boolean;
}

type Row = {
  id: string; owner_id: string; term_id: string; term: string; domain: string; definition: string;
  body: string; sign: string; hue: string; thanks: number; created_at: string;
};

const view = (r: Row): EmberNoteView => ({
  id: r.id, term: r.term, domain: r.domain, definition: r.definition, body: r.body,
  sign: r.sign, hue: r.hue, thanks: r.thanks, createdAt: r.created_at,
});

/** 去控制符 + 去首尾空白 + 按码点截断 */
function clean(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  const out = [...s].filter((c) => (c.codePointAt(0) ?? 0) >= 32 || c === '\n').join('').trim();
  return [...out].slice(0, max).join('');
}

function defaultSign(ownerId: string | null): string {
  if (!ownerId) return '无名旅人';
  const row = getDb().prepare('SELECT nickname FROM users WHERE id = ?').get(ownerId) as { nickname?: string } | undefined;
  return clean(row?.nickname ?? '', EMBER_SIGN_MAX) || '无名旅人';
}

export type EmberWrite = { ok: true; note: EmberNoteView } | { ok: false; status: number; error: string };

/** 写（或改写）一张笺。★ 只能给**自己库里**的词条写 */
export function writeEmber(ownerId: string | null, input: { termId?: unknown; body?: unknown; sign?: unknown }): EmberWrite {
  const owner = ownerForWrite(ownerId);
  const termId = typeof input.termId === 'string' ? input.termId : '';
  const t = getDb()
    .prepare('SELECT id, term, domain, definition FROM term_library WHERE id = ? AND owner_id = ?')
    .get(termId, owner) as { id: string; term: string; domain: string; definition: string } | undefined;
  if (!t) return { ok: false, status: 404, error: '这条词条不在你的库里——余烬笺只能写给自己的词条' };
  const body = clean(input.body, EMBER_BODY_MAX);
  if ([...body].length < EMBER_BODY_MIN) {
    return { ok: false, status: 400, error: `用你自己的话多写几句吧（至少 ${EMBER_BODY_MIN} 个字）——别人读到的就是这段` };
  }
  const sign = clean(input.sign, EMBER_SIGN_MAX) || defaultSign(ownerId);
  const hue = EMBER_HUES[continentHash(`hue|${t.id}`) % EMBER_HUES.length]!;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM ember_note WHERE owner_id = ? AND term_id = ?').get(owner, t.id) as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  if (existing) {
    db.prepare(`UPDATE ember_note SET body = ?, sign = ?, term = ?, domain = ?, definition = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(body, sign, t.term, t.domain, t.definition, id);
  } else {
    db.prepare(`INSERT INTO ember_note (id, owner_id, term_id, term, domain, definition, body, sign, hue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, owner, t.id, t.term, t.domain, t.definition, body, sign, hue);
  }
  const row = db.prepare('SELECT * FROM ember_note WHERE id = ?').get(id) as Row;
  return { ok: true, note: view(row) };
}

/** 我写过的笺（含被谢次数） */
export function myEmbers(ownerId: string | null): EmberNoteView[] {
  const rows = getDb()
    .prepare('SELECT * FROM ember_note WHERE owner_id = ? ORDER BY updated_at DESC')
    .all(ownerForWrite(ownerId)) as Row[];
  return rows.map(view);
}

/** 撤回自己的笺（真删；读者侧的标记跟着失效） */
export function removeEmber(ownerId: string | null, id: string): boolean {
  const db = getDb();
  const r = db.prepare('DELETE FROM ember_note WHERE id = ? AND owner_id = ?').run(id, ownerForWrite(ownerId));
  if (r.changes > 0) db.prepare('DELETE FROM ember_mark WHERE note_id = ?').run(id);
  return r.changes > 0;
}

function marksOf(owner: string, noteId: string): Set<string> {
  const rows = getDb().prepare('SELECT kind FROM ember_mark WHERE owner_id = ? AND note_id = ?').all(owner, noteId) as Array<{ kind: string }>;
  return new Set(rows.map((r) => r.kind));
}

/**
 * 今天这片大陆上的那簇异火。`dayOffset` 让「过一夜」可以预览下一簇（前端的「度过一夜」按钮）。
 * 没有别人写过笺、或你的大陆上还没有可落火的地 ⇒ `null`。
 */
export function emberSpot(ownerId: string | null, now = new Date(), dayOffset = 0): EmberSpot | null {
  const owner = ownerForWrite(ownerId);
  const day = localDayKey(new Date(now.getTime() + dayOffset * 86_400_000));
  const rows = getDb()
    .prepare(
      `SELECT * FROM ember_note n
        WHERE n.owner_id <> ?
          AND NOT EXISTS (SELECT 1 FROM ember_mark m WHERE m.owner_id = ? AND m.note_id = n.id AND m.kind IN ('kept', 'hidden'))
        ORDER BY n.id LIMIT 500`,
    )
    .all(owner, owner) as Row[];
  if (rows.length === 0) return null;
  const scan = scanMap(ownerId);
  if (scan.candidates.length === 0) return null;
  const pick = [...rows].sort((a, b) => continentHash(`${owner}|${day}|${a.id}`) - continentHash(`${owner}|${day}|${b.id}`))[0]!;
  const cell = scan.candidates[continentHash(`cell|${owner}|${day}`) % scan.candidates.length]!;
  const marks = marksOf(owner, pick.id);
  return { note: view(pick), row: cell.row, col: cell.col, kept: marks.has('kept'), thanked: marks.has('thanked') };
}

function noteById(id: string): Row | undefined {
  return getDb().prepare('SELECT * FROM ember_note WHERE id = ?').get(id) as Row | undefined;
}

export type EmberAct = { ok: true; termId?: string; already?: boolean; thanks?: number } | { ok: false; status: number; error: string };

/** 收入卡册：把那条词条加进自己的库。★ 已有同名同领域词条 ⇒ 不覆盖你的释义，只记一笔「收过」 */
export function keepEmber(ownerId: string | null, id: string): EmberAct {
  const owner = ownerForWrite(ownerId);
  const n = noteById(id);
  if (!n) return { ok: false, status: 404, error: '这簇火已经熄了（作者撤回了这张笺）' };
  if (n.owner_id === owner) return { ok: false, status: 409, error: '这是你自己写的笺' };
  const d = (n.domain || '').trim().toLowerCase().slice(0, 30) || 'general';
  const hit = buildTermIndex(ownerId).find(n.term, d);
  let termId = hit ?? undefined;
  if (!hit) {
    const definition = n.definition || n.body;
    termId = saveOneTerm(n.term, definition, n.domain, ownerId).id;
  }
  getDb().prepare('INSERT OR IGNORE INTO ember_mark (owner_id, note_id, kind) VALUES (?, ?, ?)').run(owner, id, 'kept');
  return { ok: true, termId, already: Boolean(hit) };
}

/** 添柴致谢：每人每张只算一次 */
export function thankEmber(ownerId: string | null, id: string): EmberAct {
  const owner = ownerForWrite(ownerId);
  const n = noteById(id);
  if (!n) return { ok: false, status: 404, error: '这簇火已经熄了（作者撤回了这张笺）' };
  if (n.owner_id === owner) return { ok: false, status: 409, error: '不能给自己的火添柴' };
  const db = getDb();
  const r = db.prepare('INSERT OR IGNORE INTO ember_mark (owner_id, note_id, kind) VALUES (?, ?, ?)').run(owner, id, 'thanked');
  if (r.changes > 0) db.prepare('UPDATE ember_note SET thanks = thanks + 1 WHERE id = ?').run(id);
  const thanks = (noteById(id)?.thanks ?? n.thanks);
  return { ok: true, thanks, already: r.changes === 0 };
}

/** 不想再看 / 举报：先对自己下线 */
export function hideEmber(ownerId: string | null, id: string): EmberAct {
  if (!noteById(id)) return { ok: false, status: 404, error: '这簇火已经熄了' };
  getDb().prepare('INSERT OR IGNORE INTO ember_mark (owner_id, note_id, kind) VALUES (?, ?, ?)').run(ownerForWrite(ownerId), id, 'hidden');
  return { ok: true };
}
