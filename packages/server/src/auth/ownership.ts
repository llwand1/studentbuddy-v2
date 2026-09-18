/**
 * auth/ownership — 数据归属解析（契约 docs/TENANCY-SPEC.md §1 / §4 / §5）。
 *
 * ★ 归属模型一句话：**会话是唯一锚点**。消息等子表不加 `user_id`，随父会话继承归属
 *   ——两个事实源迟早漂移（本仓 register/me 的 `createdAt` 已付过一次学费），
 *   「子表随父表」是从模型上消灭漂移，而不是靠"记得同步两列"。
 *
 * ★ `ownerId === null` 的语义是「**未登录的单人本地模式**」，不是「无主」：
 *   此时不过滤，维持本仓本地单用户的既有行为（服务只绑 127.0.0.1）。
 *   安全边界由部署形态保证——生产必开 `SB_REQUIRE_AUTH=1`，则每条请求必有 user ⇒ 必过滤。
 */
import { getDb } from '../storage/db.js';
import type { Request } from 'express';
import type { AuthedRequest } from './middleware.js';

/** 取请求的归属用户 id。未登录 → `null`（做过滤豁免，见文件头说明）。 */
export function ownerIdOf(req: Request): string | null {
  const user = (req as AuthedRequest).authUser;
  return user ? user.id : null;
}

/**
 * 归属过滤条件：`ownerId` 为 null 时**不加条件**（单人本地模式）。
 * 返回的 `params` 必须按序拼进 `prepare(...).all(...)`，与 `sql` 里的 `?` 一一对应。
 */
export function ownerFilter(ownerId: string | null, column = 'user_id'): { sql: string; params: string[] } {
  if (ownerId === null) return { sql: '', params: [] };
  return { sql: ` AND ${column} = ?`, params: [ownerId] };
}

/**
 * 会话归属断言。
 *
 * ★ **不归属一律 `false`，路由必须回 404 而不是 403**——403 等于告诉对方
 *   「这个 id 存在，只是不是你的」，是把会话 id 当敏感标识外泄。
 * ★ `ownerId` 为 null（未登录单人模式）→ 放行，维持旧行为。
 */
export function canAccessSession(sessionId: string, ownerId: string | null): boolean {
  if (!sessionId) return false;
  if (ownerId === null) return true; // 单人本地模式：不做归属判定
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(sessionId, ownerId);
  return row !== undefined;
}

/**
 * 读某个会话的归属用户 id（M2c，契约 TENANCY-SPEC §8.1.4）。
 *
 * ★ 为什么要有它：学习流 `advanceRun` 既会被 HTTP 路由推进，也会在恢复/重试路径上被推进，
 *   而「这个 run 是谁的」是**持久事实**（`sessions.user_id`），不是「这次是谁点的」。
 *   从持久事实取 ⇒ 任何推进路径都自动正确，不必给推进函数加参再指望每个调用点都记得传
 *   （漏传的表现是"这一步的模型调用记到平台头上"，无声无息）。
 * ★ 会话不存在 / 会话无主 ⇒ `null`，与 `ownerIdOf`、`ownerFilter(null)` 同一口径。
 */
export function ownerOfSession(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const row = getDb().prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessionId) as
    | { user_id: string | null }
    | undefined;
  return row?.user_id ?? null;
}

/**
 * 建会话的**唯一落点**。
 *
 * ★ 为什么必须有这个函数：`POST /api/sessions` 与学习流 `createRun` 都会建会话，
 *   两处各写各的 INSERT，迟早有一处忘了写 `user_id`——而漏写的后果是
 *   **那条会话变成孤儿，主人自己也永远看不到它**（比泄露更隐蔽、更难排查）。
 *   统一到一处，`user_id` 由签名强制传入（不给"忘传"留口子，只给"传 null"的显式豁免）。
 */
export function insertSession(id: string, ownerId: string | null, title?: string): void {
  const db = getDb();
  if (title === undefined) {
    db.prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(id, ownerId);
    return;
  }
  db.prepare('INSERT INTO sessions (id, user_id, title) VALUES (?, ?, ?)').run(id, ownerId, title);
}
