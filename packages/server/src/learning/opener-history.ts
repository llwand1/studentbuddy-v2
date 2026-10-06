/** 仅保存用户近期题干的不可回显摘要，刷新后也能防重复；不保存题目或答案。 */
import { createHash } from 'node:crypto';
import { OPENER_HISTORY_LIMIT, openerFingerprint } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

const KEY = 'campfire_opener_seen';
const digest = (stem: string): string => createHash('sha256').update(openerFingerprint(stem)).digest('hex');

function history(ownerId: string | null): string[] {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?').get(ownerForWrite(ownerId), KEY) as { value: string } | undefined;
  try {
    const parsed: unknown = JSON.parse(row?.value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)).slice(-OPENER_HISTORY_LIMIT) : [];
  } catch { return []; }
}

export function openerAlreadySeen(ownerId: string | null, stem: string): boolean {
  return history(ownerId).includes(digest(stem));
}

/** 同步认领，两个并发请求不能交付相同题干。 */
export function claimOpener(ownerId: string | null, stem: string): boolean {
  const seen = history(ownerId);
  const hash = digest(stem);
  if (seen.includes(hash)) return false;
  getDb().prepare('INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value')
    .run(ownerForWrite(ownerId), KEY, JSON.stringify([...seen, hash].slice(-OPENER_HISTORY_LIMIT)));
  return true;
}
