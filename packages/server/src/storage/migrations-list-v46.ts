/**
 * v46（2026-09-29 AI 网关 + 学习事件 + 后台任务）——三张表，各管一件事：
 *
 * ① `llm_call`：**每一次**模型调用一行（成功、超时、上游报错、解析失败、没配模型都记）。
 *    写入方只有 `ai/call-log.ts`（总线订阅者）；调用方经 `ai/gateway.ts` 发事件，自己不碰库。
 *    ★ `purpose` 是业务用途（`term.extract`、`quiz.generate`…，登记在 `ai/purposes.ts`），
 *      `role` 是模型角色——两者不是一回事：同一个角色（explain）被抽词、整理、NPC 三处复用，
 *      只看 role 就分不清是谁在花钱、谁在失败。
 *    ★ `prompt_version` 跟着提示词走：改了提示词就能按版本对比成功率与耗时。
 *
 * ② `learning_event`：**学习行为**的单一事件流（复习、答题、新词条、对话一轮…）。
 *    与 `event_log`（可观测：延迟/检索/点踩，面向运维）刻意分开：这张表面向「这个人学了什么」，
 *    是之后记忆模型（FSRS）、学习者画像、成就等投影的共同数据源。只追加不改。
 *
 * ③ `job`：持久化后台任务队列。`dedupe_key` 唯一 ⇒ 同一件事重复入队只落一行；
 *    `run_after` 做退避重试；进程重启时把卡在 running 的任务放回 queued（见 `jobs/queue.ts`）。
 */
export const MIGRATIONS_V46: Array<{ version: number; statements: string[] }> = [
  {
    version: 46,
    statements: [
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
      `CREATE TABLE IF NOT EXISTS learning_event (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id     TEXT NOT NULL DEFAULT '',
        kind         TEXT NOT NULL,
        subject_id   TEXT,
        payload      TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        day          TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_learning_event_owner_day ON learning_event(owner_id, day)`,
      `CREATE INDEX IF NOT EXISTS idx_learning_event_subject ON learning_event(owner_id, subject_id)`,
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
