import { getDb } from '../storage/db.js';
import { canAccessSession, ownerForWrite, sessionExists } from '../auth/ownership.js';

const KEY = 'desktop.float.workspace';
export function loadWorkspace(owner: string | null): { sessionId: string | null } {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(owner), KEY) as { value: string } | undefined;
  const id = row?.value;
  return { sessionId: id && sessionExists(id) && canAccessSession(id, owner) ? id : null };
}
export function saveWorkspace(owner: string | null, sessionId: string | null): void {
  getDb().prepare('INSERT INTO app_settings (owner_id,key,value) VALUES (?,?,?) ON CONFLICT(owner_id,key) DO UPDATE SET value=excluded.value')
    .run(ownerForWrite(owner), KEY, sessionId ?? '');
}
