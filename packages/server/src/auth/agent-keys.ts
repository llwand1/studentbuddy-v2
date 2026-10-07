/** 专用凭证仅在开放词条路由校验，不能当登录会话。 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentKeyView } from '@sb/shared';
import { AGENT_KEY_MAX_DAYS } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from './ownership.js';
import { hashToken } from './session.js';
import { deployForm } from './form.js';
import { findUserById } from './users.js';

interface KeyRow {
  id: string; owner_id: string; name: string; prefix: string; created_at: number;
  expires_at: number; last_used_at: number | null; revoked_at: number | null;
}
const view = (r: KeyRow): AgentKeyView => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at,
  expiresAt: r.expires_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at });
export class AgentKeyError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function listAgentKeys(ownerId: string | null): AgentKeyView[] {
  return (getDb().prepare('SELECT * FROM agent_term_key WHERE owner_id = ? ORDER BY created_at DESC LIMIT 30').all(ownerForWrite(ownerId)) as KeyRow[]).map(view);
}
export function createAgentKey(ownerId: string | null, input: unknown, now = Date.now()): { key: AgentKeyView; token: string } {
  const r = input as { name?: unknown; days?: unknown } | null;
  if (!r || typeof input !== 'object' || Array.isArray(input) || typeof r.name !== 'string' || !r.name.trim() || r.name.trim().length > 40) throw new AgentKeyError(400, '密钥名称需要 1–40 字。');
  const days = r.days === undefined ? 30 : r.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > AGENT_KEY_MAX_DAYS) throw new AgentKeyError(400, '有效期需要 1–90 天。');
  const owner = ownerForWrite(ownerId);
  const db = getDb();
  const n = (db.prepare('SELECT COUNT(*) n FROM agent_term_key WHERE owner_id = ? AND revoked_at IS NULL AND expires_at > ?').get(owner, now) as { n: number }).n;
  if (n >= 5) throw new AgentKeyError(429, '最多保留 5 个有效密钥，请先撤销不用的密钥。');
  const token = 'sb_terms_' + randomBytes(32).toString('base64url');
  const row: KeyRow = { id: randomUUID(), owner_id: owner, name: r.name.trim(), prefix: token.slice(0, 17),
    created_at: now, expires_at: now + days * 86400000, last_used_at: null, revoked_at: null };
  db.prepare('INSERT INTO agent_term_key (id,owner_id,name,token_hash,prefix,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(row.id, owner, row.name, hashToken(token), row.prefix, now, row.expires_at);
  return { key: view(row), token };
}
export function revokeAgentKey(ownerId: string | null, id: string): boolean {
  return getDb().prepare('UPDATE agent_term_key SET revoked_at = COALESCE(revoked_at,?) WHERE id = ? AND owner_id = ?')
    .run(Date.now(), id, ownerForWrite(ownerId)).changes > 0;
}
export function verifyAgentKey(token: string, now = Date.now()): { id: string; ownerId: string | null } | null {
  if (!/^sb_terms_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = getDb().prepare('SELECT * FROM agent_term_key WHERE token_hash = ?').get(hashToken(token)) as KeyRow | undefined;
  if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
  if (row.owner_id ? !findUserById(row.owner_id) : deployForm() === 'cloud') return null;
  getDb().prepare('UPDATE agent_term_key SET last_used_at = ? WHERE id = ?').run(now, row.id);
  return { id: row.id, ownerId: row.owner_id || null };
}
