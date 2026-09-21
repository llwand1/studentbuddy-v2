/**
 * auth/user-row — `users` 表行 → 契约用户（`AuthUser`）的**唯一一份**映射。
 *
 * ★★ **为什么必须单开一个文件**（2026-09-21 独立建号批的真实教训，值得逐字读）：
 *   此前 `users.ts` 与 `github.ts` **各写了一份** `toAuthUser`，两份都只是
 *   `{ id, email: row.email, nickname, createdAt }` —— 当时**看不出问题**（两份逐字相同）。
 *   本批把 GitHub 账号的真实邮箱挪去 `github_email` 列（`users.email` 只放占位串）后，
 *   **只改了 `github.ts` 那一份**，`users.ts` 那份照旧读 `email` ⇒ **`/api/auth/me`
 *   直接把占位串 `gh-9001@users.noreply.invalid` 返回给用户**（`AccountTrigger.tsx` 会把它
 *   渲染进账号菜单）。★★ **是测试逮到的**：断言「接口返回不含 `noreply.invalid`」当场红。
 *   ⚠️ 而这一切**没有任何编译错误提示** —— `row.email` 仍是 `string`，类型完全合法。
 *   ⇒ 结论同 `shared/study-flow-params.ts`：**映射规则属于契约，只允许一份实现**。
 *     两份各自演化时，「改了 A 忘了 B」既不报错、也不会有任何症状指向缺失的那一处。
 *
 * ★ 消费方：`auth/users.ts`（邮箱账号路径）、`auth/github.ts`（GitHub 账号路径）——
 *   两者**必须**走同一份映射，否则同一个账号在两个端点会「长得不一样」。
 */
import type { AuthUser } from '@sb/shared';

/** `users` 表的一行（只列映射用得到的列，不是全表投影）。 */
export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  nickname: string;
  github_id: string | null;
  github_email: string | null;
  created_at: string;
}

/**
 * 行 → 契约用户。★ **绝不带出 `password_hash`** —— 它是库内列，不是契约字段。
 *
 * ★★ `email` 取 `github_email ?? email`：GitHub 账号的 `users.email` 是**占位串**
 *   （`gh-<id>@users.noreply.invalid`，来历见 `migrations-list-v40.ts`），**绝不能**返回给用户；
 *   而邮箱账号的 `github_email` 恒为 `NULL` ⇒ 回落取 `email`，与改口径前**逐字相同**
 *   （老账号零感知）。★ 改动这一行前先想清楚：**它是所有 auth 端点 email 的唯一出口**。
 */
export function rowToAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.github_email ?? row.email, nickname: row.nickname, createdAt: row.created_at };
}
