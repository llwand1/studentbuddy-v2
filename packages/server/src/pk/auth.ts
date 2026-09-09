/**
 * pk/auth — PK 登录域逻辑（契约 docs/PK-SPEC.md §2.1，P0-1）。
 *
 * 账号模型：一次登录 = 一条 pk_users 记录。客户端把 userId 存本地（localStorage），
 * 再次登录携带 userId 即找回原账号（改名允许）；不携带或账号不存在则新建。
 * openid 为 P0 模拟值 `mock_<userId>`——P1 换微信公众号网页授权时，只替换本文件的
 * openid 生成处与路由入参解析，响应结构（PkIdentity）与前端零改动。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import type { PkIdentity } from '@sb/shared';

/** 昵称规则：trim 后 1~20 字（前端同规则校验，服务端是唯一权威） */
export const NICKNAME_MAX = 20;

export function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const nickname = raw.trim();
  if (!nickname || nickname.length > NICKNAME_MAX) return null;
  return nickname;
}

interface PkUserRow {
  id: string;
  openid: string;
  nickname: string;
}

function toIdentity(row: PkUserRow): PkIdentity {
  return { userId: row.id, openid: row.openid, nickname: row.nickname };
}

/** 按 userId 找账号（前端启动时校验本地登录态用）；不存在/缺参 → null */
export function getIdentity(userId: unknown): PkIdentity | null {
  if (typeof userId !== 'string' || !userId) return null;
  const row = getDb().prepare(`SELECT id, openid, nickname FROM pk_users WHERE id = ?`).get(userId) as
    | PkUserRow
    | undefined;
  return row ? toIdentity(row) : null;
}

/**
 * 登录（模拟）：userId 命中已有账号 → 更新昵称与 last_seen（允许改名）；
 * 否则新建账号。返回登录后的完整身份。
 */
export function loginOrRegister(rawNickname: string, rawUserId?: unknown): PkIdentity {
  const nickname = normalizeNickname(rawNickname);
  if (!nickname) throw new Error('NICKNAME_INVALID');
  const db = getDb();
  const existing = getIdentity(rawUserId);
  if (existing) {
    db.prepare(`UPDATE pk_users SET nickname = ?, last_seen_at = datetime('now') WHERE id = ?`).run(
      nickname,
      existing.userId,
    );
    return { ...existing, nickname };
  }
  const userId = `u-${randomUUID()}`;
  db.prepare(`INSERT INTO pk_users (id, openid, nickname) VALUES (?, ?, ?)`).run(userId, `mock_${userId}`, nickname);
  return { userId, openid: `mock_${userId}`, nickname };
}
