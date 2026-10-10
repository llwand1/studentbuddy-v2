/**
 * v58（2026-10-10）—— **修复迁移号撞车**：幂等补建 `job` / `llm_call`。
 *
 * ── 事故还原（每一条都有实证，不是推测）──────────────────────────────────
 * `version: 46` 在两条线上各定义过一次，内容不同：
 * · 旧线（`3931f2a`，fix/search-key-priority 线，2026-09-27「E1 学习事件流」）：
 *   建 `review_log` + `learning_event` **两表**；
 * · 新主干（`01a0051`「AI 网关 + 学习事件 + 后台任务」）：建 `llm_call` + `learning_event`
 *   + `job` **三表**（即本仓现行 `migrations-list-v46.ts`）。
 * 被旧线代码先迁移过的库（真机实测一例：`AppData/Roaming/studentbuddy-v2`），
 * `schema_version` 已记录 46 ⇒ 新主干代码按号跳过 v46 ⇒ `job` / `llm_call` **永久缺失**。
 * 而服务启动路径无条件 `recoverStaleJobs()` 查 `job`（`jobs/worker.ts`）⇒
 * `SqliteError: no such table: job` ⇒ **整个服务起不来**（桌面版实测崩在启动）。
 *
 * ── 为什么用「新版本号重申」而不是「改 v46」─────────────────────────────
 * `migrations.ts` 按 `schema_version` 跳过已应用版本——改 v46 的语句体对中招库毫无作用
 * （46 已记账，永不重跑），这正是「链上历史不回改」铁律的机制原因。唯一能自愈中招库的
 * 动作是**发一条新版本号**的迁移，把缺的 DDL 以 `IF NOT EXISTS` 再断言一遍。
 *
 * ── 幂等性 ────────────────────────────────────────────────────────────────
 * · 中招库（记了 46 但缺两表）：v58 建出与 v46 逐字一致的结构 ⇒ 自愈；
 * · 健康库（v46 正常跑过）：`IF NOT EXISTS` 全部 no-op，仅 `schema_version` 多记一行 58；
 * · 全新库：v46 建表在先，v58 同样 no-op。
 * DDL 与 v46 **逐字一致**（含索引），保证任何路径建出的结构相同。
 *
 * ── 纵深防御（与本迁移配套的另一层）──────────────────────────────────────
 * `jobs/worker.ts` 的 `startJobWorker()` 同时加了守卫：`job` 表缺失时**不再崩掉整个服务**，
 * 而是打日志、跳过队列启动（`dispatchJob` 自动退回内联执行路径）。两层各挡一种未来：
 * 迁移层治「这次的撞车」，守卫层治「下次再有表被漏掉时不至于全服务瘫痪」。
 */
export const MIGRATIONS_V58: Array<{ version: number; statements: string[] }> = [
  {
    version: 58,
    statements: [
      // ↓ 与 migrations-list-v46.ts 的 llm_call 逐字一致（IF NOT EXISTS = 健康库 no-op）
      `CREATE TABLE IF NOT EXISTS llm_call (
        id                TEXT PRIMARY KEY,
        owner_id          TEXT,
        purpose           TEXT NOT NULL,
        prompt_version    INTEGER NOT NULL DEFAULT 1,
        role              TEXT NOT NULL,
        model             TEXT NOT NULL DEFAULT '',
        platform          INTEGER NOT NULL DEFAULT 0,
        status            TEXT NOT NULL,
        attempt           INTEGER NOT NULL DEFAULT 1,
        latency_ms        INTEGER NOT NULL DEFAULT 0,
        prompt_tokens     INTEGER,
        completion_tokens INTEGER,
        finish_reason     TEXT,
        error             TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_llm_call_created ON llm_call(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_llm_call_owner_purpose ON llm_call(owner_id, purpose)`,
      // ↓ 与 migrations-list-v46.ts 的 job 逐字一致
      `CREATE TABLE IF NOT EXISTS job (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT,
        kind        TEXT NOT NULL,
        dedupe_key  TEXT UNIQUE,
        payload     TEXT NOT NULL DEFAULT '{}',
        status      TEXT NOT NULL DEFAULT 'queued',
        attempts    INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after   INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_job_pick ON job(status, run_after)`,
      `CREATE INDEX IF NOT EXISTS idx_job_owner ON job(owner_id, created_at)`,
    ],
  },
];