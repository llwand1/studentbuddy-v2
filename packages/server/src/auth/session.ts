/**
 * auth/session — 会话 token 的签发 / 校验 / 撤除（契约 docs/AUTH-SPEC.md §1 `auth_sessions` / §4.2）。
 *
 * ★ 库里**只存 SHA-256(token) 的十六进制**，不存明文 token——与「provider api_key 加密落库」
 *   同一取向：**即便拖库，拿到的也是一堆哈希，无法直接当会话用**。明文只存在于
 *   客户端 cookie 与服务端这一次的返回里。
 *
 * ★ 过期判定只看 `expires_at`（ms 整数，应用层比较）；`last_seen_at` **纯观察**，不参与判定——
 *   「滑动过期」（每请求续期）会让会话永不过期，安全上更松，本版刻意不做（与 `AUTH_SESSION_TTL_MS` 对齐）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { AUTH_SESSION_TTL_MS } from '@sb/shared';
import { getDb } from '../storage/db.js';

/** token → 库内主键（哈希）。单独导出供测试断言「库里存的确实不是明文」。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** token 字节数：32 字节随机（base64url 后 43 字符），碰撞概率可忽略。 */
const TOKEN_BYTES = 32;

/**
 * 签发会话。`ttlMs` 可注入（**仅测试用**——生产调用不传，走 `AUTH_SESSION_TTL_MS`）。
 * 返回**明文 token**（写给 cookie 的唯一时机）+ 过期时刻；此后库里再无明文。
 */
export function createSession(userId: string, ttlMs: number = AUTH_SESSION_TTL_MS): { token: string; expiresAt: number } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const now = Date.now();
  const expiresAt = now + ttlMs;
  getDb()
    .prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, last_seen_at) VALUES (?, ?, ?, ?)`)
    .run(hashToken(token), userId, expiresAt, now);
  return { token, expiresAt };
}

/**
 * 校验会话：命中且未过期 → 返回 `userId` 并刷新 `last_seen_at`；
 * 否则 `null`（未知 token / 已过期 / 非字符串）。**已过期的行顺手删掉**（惰性清理，省一个定时器）。
 */
export function verifySession(token: unknown): string | null {
  if (typeof token !== 'string' || !token) return null;
  const db = getDb();
  const tokenHash = hashToken(token);
  const row = db
    .prepare(`SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?`)
    .get(tokenHash) as { user_id: string; expires_at: number } | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at <= now) {
    db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(tokenHash);
    return null;
  }
  db.prepare(`UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?`).run(now, tokenHash);
  return row.user_id;
}

/** 撤除单个会话（登出）。未知 token 静默——登出必须幂等，不能让「重复登出」报错。 */
export function deleteSession(token: unknown): void {
  if (typeof token !== 'string' || !token) return;
  getDb().prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(hashToken(token));
}

/** 清理全部已过期会话（启动时调一次，同 `sweepStaleChoices` 的逃生口手法）。返回清理条数。 */
export function purgeExpiredSessions(now = Date.now()): number {
  return getDb().prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(now).changes;
}
