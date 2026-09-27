/**
 * auth/session 测试（隔离库）：签发 / 校验 / 登出幂等 / 过期惰性清理 / **库内只存哈希不存明文**。
 *
 * ★ 用 `SB_DATA_DIR` 指向临时目录（同 `routes/pk-auth.test.ts` 手法）——会话是**库内状态**，
 *   不隔离就会往真实库写行。
 * ★ 最要紧的一条断言是「**库里存的不是明文 token**」：它是「拖库拿不到可用会话」这个安全承诺的
 *   唯一可验证形式。若哪天有人图省事改成存明文，这条会立刻红。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-auth-session-test-'));
const { getDb, closeDb } = await import('../storage/db.js');
const { createSession, verifySession, deleteSession, purgeExpiredSessions, hashToken } = await import('./session.js');

/** 直接读会话行（断言库内形态用）。 */
function sessionRow(token: string): { token_hash: string; user_id: string; expires_at: number } | undefined {
  return getDb()
    .prepare(`SELECT token_hash, user_id, expires_at FROM auth_sessions WHERE token_hash = ?`)
    .get(hashToken(token)) as { token_hash: string; user_id: string; expires_at: number } | undefined;
}

describe('auth/session — 签发与库内形态', () => {
  it('签发返回明文 token + 过期时刻；**库内只存 SHA-256 哈希**', () => {
    const { token, expiresAt } = createSession('u-alice');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
    expect(expiresAt).toBeGreaterThan(Date.now());

    const row = sessionRow(token);
    expect(row).toBeTruthy();
    expect(row!.user_id).toBe('u-alice');
    expect(row!.token_hash).toBe(hashToken(token));
    // 明文 token 不得以任何形式落在主键上
    expect(row!.token_hash).not.toBe(token);
    expect(getDb().prepare(`SELECT 1 FROM auth_sessions WHERE token_hash = ?`).get(token)).toBeUndefined();
  });

  it('两次签发产生不同 token（32 字节随机）', () => {
    const a = createSession('u-bob');
    const b = createSession('u-bob');
    expect(a.token).not.toBe(b.token);
  });

  it('hashToken 是确定性的且为 64 位十六进制', () => {
    const t = 'fixed-token';
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('auth/session — 校验', () => {
  it('有效 token → 返回 userId，并刷新 last_seen_at', () => {
    const { token } = createSession('u-cat');
    const before = (getDb().prepare(`SELECT last_seen_at FROM auth_sessions WHERE token_hash = ?`).get(hashToken(token)) as {
      last_seen_at: number;
    }).last_seen_at;
    expect(verifySession(token)).toBe('u-cat');
    const after = (getDb().prepare(`SELECT last_seen_at FROM auth_sessions WHERE token_hash = ?`).get(hashToken(token)) as {
      last_seen_at: number;
    }).last_seen_at;
    expect(after).toBeGreaterThanOrEqual(before); // 观察字段被刷新
  });

  it('未知 / 非字符串 / 空 token → null（不抛）', () => {
    expect(verifySession('no-such-token')).toBeNull();
    expect(verifySession('')).toBeNull();
    expect(verifySession(undefined)).toBeNull();
    expect(verifySession(12345)).toBeNull();
  });

  it('已过期 token → null，且**过期行被顺手删掉**（惰性清理）', () => {
    const { token } = createSession('u-old', -1000); // 已过期
    expect(sessionRow(token)).toBeTruthy(); // 先确实落了库
    expect(verifySession(token)).toBeNull();
    expect(sessionRow(token)).toBeUndefined(); // 校验时被清掉
  });
});

describe('auth/session — 登出与清理', () => {
  it('登出撤除会话；**重复登出幂等**（不抛）', () => {
    const { token } = createSession('u-dave');
    expect(verifySession(token)).toBe('u-dave');
    deleteSession(token);
    expect(verifySession(token)).toBeNull();

    expect(() => deleteSession(token)).not.toThrow(); // 第二次登出
    expect(() => deleteSession(null)).not.toThrow(); // 无会话调用
  });

  it('purgeExpiredSessions 清掉过期的、保留有效的', () => {
    const dead = createSession('u-dead', -1);
    const live = createSession('u-live');
    const purged = purgeExpiredSessions();
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(sessionRow(dead.token)).toBeUndefined();
    expect(sessionRow(live.token)).toBeTruthy();
  });
});

afterAll(() => {
  closeDb();
});
