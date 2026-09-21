/**
 * storage/migrations-list-v40 — **v40 及之后**的迁移分片（2026-09-21 七次拆分）。
 *
 * **为什么又切一片**：上一片 `migrations-list-v31.ts` 装到 v39 时已 **379 行**（AGENTS.md
 * 「`.ts` ≤400 行」红线）。而 v40 的注释（为什么用占位串、为什么不动 UNIQUE 约束）是
 * **不可省的**——它是下次有人想「把占位改回真实邮箱、顺手把 UNIQUE 去掉」时唯一的拦路牌。
 * 按仓规 **拆文件、不压注释**（沿用 v10 / v18 / v22 / v30 / v31 五次同款先例）。
 *
 * ⚠️ 回放迁移链的测试必须把**加列**也 DROP 掉（`ALTER TABLE ADD COLUMN` 不幂等）。
 *   本仓已实测踩过**九次** `duplicate column name`，见 `storage/db.test.ts` 的 `revertV40`。
 */

/**
 * ── v40：GitHub 独立建号（2026-09-21，契约 `docs/AUTH-SPEC.md` §2.8 口径 1 重写）──
 *
 * 背景：GitHub 登录由「**按邮箱自动归并**」改为「**严格独立建号**」—— 同一邮箱在站内有
 * 邮箱账号、GitHub 也用该邮箱时，算**两个彼此独立的账号**（老板 2026-09-21 拍板）。
 *
 * ★★ **本列为什么必须存在**：`users.email` 是 `TEXT NOT NULL UNIQUE`，而新口径要求
 *   「同一真实邮箱可对应两个账号」⇒ **真实邮箱进不了 `email` 列**。改 UNIQUE 约束在
 *   SQLite 要**整表重建**（12 步流程），风险与收益不成比例 ⇒ 改为：GitHub 账号在
 *   `email` 列写**占位串** `gh-<github_id>@users.noreply.invalid`（`.invalid` 是
 *   RFC 2606 **保留 TLD、永不可解析**；`github_id` 唯一 ⇒ 占位串唯一性**天然成立**），
 *   真实邮箱另存本列，**仅作展示**（`AuthUser.email` 取 `github_email ?? email`，
 *   用户在账号菜单里看到的仍是真实邮箱，**占位串绝不出现在任何接口返回里**）。
 *
 * ★ **零数据风险**：本迁移落地时线上 **0 个账号**带 `github_id`（凭据 2026-09-21 才配齐、
 *   尚无人登录过）⇒ 纯加列，**无回填、无历史数据处理**。⚠️ 但这**不等于**「以后也不会需要
 *   回填」—— 若将来在 GitHub 通道已被使用之后才改口径，就必须写数据迁移（届时单独评估）。
 *
 * ★ 可空、**无约束、无索引**：邮箱注册的老账号与「拿不到邮箱」的 GitHub 账号此列均为
 *   `NULL`。它**只读不查** —— 不作身份依据、不进任何 `WHERE`（认人只认 `github_id`）。
 */
export const MIGRATIONS_V40: Array<{ version: number; statements: string[] }> = [
  {
    version: 40,
    statements: [`ALTER TABLE users ADD COLUMN github_email TEXT`],
  },
];
