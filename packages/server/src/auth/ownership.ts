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
 *
 * ★★ **只用于 v22/v24 的 `sessions` / `user_memory`**（它们的孤儿行是 `NULL`，且读形状是
 *   「按 id 取一行 / 列一批行」）。★ **M2d 系列的表（`app_settings` / `daily_*` / `user_stats` /
 *   `term_*` / `quiz_*` / `flow_*`）不要用它**，一律改用 `ownerForWrite(ownerId)`——
 *   理由见 `ownerForWrite` 的注释（那些表的读形状是**单值或聚合**，"豁免过滤"会返回
 *   任意一个用户的行）。两者不是"同一个东西的两种写法"，选错**不报错**。
 *
 * ★ 默认列名仍是 `user_id`，**不要**为了"统一"把默认值改成 `owner_id`——改默认值会让
 *   `sessions` 的过滤条件指向一个不存在的列（SQL 直接报错，还算好的）；更坏的是将来某张表
 *   恰好两列都有，静默过滤错列 ⇒ 泄露且不报错。
 */
export function ownerFilter(ownerId: string | null, column = 'user_id'): { sql: string; params: string[] } {
  if (ownerId === null) return { sql: '', params: [] };
  return { sql: ` AND ${column} = ?`, params: [ownerId] };
}

/**
 * M2d 表的归属值：把「这次请求的归属」转成**列值**，**读写两侧都用它**（契约 §8.2）。
 *
 * ★★ 为什么读侧也用它（而不是 `ownerFilter` 的"null 就豁免过滤"）——这是本批最容易写错、
 *   而且**写错不报错**的一处，2026-09-18 开工时实测踩到：
 *   M2d 这组表的读形状是**单值或聚合**，不是"按 id 列一批行"：
 *   · `app_settings`：`SELECT value … WHERE key = ?` → `.get()`。豁免过滤后库里若有多行
 *     （每个用户一行），`.get()` 返回的是**任意一行** ⇒ 未登录请求读到**某个用户**的出题配比 /
 *     回答方式偏好 / 搜索 key（**静默串台**，且不会报错）。
 *   · `daily_summaries`：同上 ⇒ **B 直接读到 A 的今日总结**（那正是本批要修的那个洞）。
 *   · `user_stats`：同上 ⇒ 未登录读到**某个用户**的 XP。
 *   · `daily_activity`：`SUM(count)` ⇒ 把**所有人**的活动加在一起。
 *   ⇒ 故本组表**读写同口径**：`''` = 无主行；未登录只看无主行、登录只看自己的行。
 *     `null`（未登录单人模式）⇒ `''`，而本地模式写入的行**本来就是无主行**（同一把 helper），
 *     所以"看到的就是自己全部历史"这条仍然成立——契约 §9 第 5 条没有被违反。
 *   ★ 判据一句话：**读形状是"一批行"的用 `ownerFilter`；是"一个值"的用本函数。**
 */
export function ownerForWrite(ownerId: string | null): string {
  return ownerId ?? '';
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
 * 会话是否**真的存在且未删**（**不做归属判定**，与 `canAccessSession` 是两个问题）。
 *
 * ★ 为什么必须与归属断言分开：`canAccessSession` 在**未登录单人模式**（`ownerId === null`）下
 *   **不查库就放行**（那是刻意的旧行为兼容）。只读端点因此不需要本函数——查不到就是空列表、
 *   空消息，无害。但**写"引用父行"的端点不行**：`POST /api/sessions/:id/fork` 会落一行
 *   带 `forked_from_id` 的会话，源 id 乱写的话，库里就留一条指向虚空的 fork 记录
 *   （而且它带着「追问：X」的标题挂在侧栏，用户删都删不明白）。
 *   这类端点必须在归属断言之外**再补一道存在性断言**。
 */
export function sessionExists(sessionId: string): boolean {
  if (!sessionId) return false;
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM sessions WHERE id = ? AND deleted_at IS NULL')
    .get(sessionId);
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
 *
 * ★ v38 起补 `fork?: { fromSessionId, term }`（契约 docs/KNOWLEDGE-FOLLOWUP-SPEC.md §5.2）：
 *   「向 AI 追问」要建的是一条**带出处的**会话。两个新字段也走这里、不另开 INSERT 口——
 *   理由与上面 `user_id` 完全相同：多一个建会话的写口，就多一个漏写归属的机会。
 *   `term` 在库里是**抗删快照**（存名不存 id，见迁移 v38 注释）。
 *
 * ★ 列名/值对是**逐项拼**的（不是两个写死的分支）：再加第三个可选字段时不用再开一条 INSERT。
 *   拼进 SQL 的**只有本函数写死的列名**，值一律走占位符——没有注入面。
 */
export function insertSession(
  id: string,
  ownerId: string | null,
  title?: string,
  fork?: { fromSessionId: string; term: string },
): void {
  const cols = ['id', 'user_id'];
  const vals: Array<string | null> = [id, ownerId];
  if (title !== undefined) {
    cols.push('title');
    vals.push(title);
  }
  if (fork) {
    cols.push('forked_from_id', 'forked_term');
    vals.push(fork.fromSessionId, fork.term);
  }
  getDb()
    .prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...vals);
}
