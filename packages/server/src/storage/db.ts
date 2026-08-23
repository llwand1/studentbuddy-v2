/**
 * storage/db — SQLite 单文件（WAL + 外键），schema_version 逐语句版本化迁移。
 * v2 铁律（ADR-6）：不用大模板字符串批量 exec（v1 TS1434 坑根除）；每版迁移一个数组；
 * 索引与建表同批；messages(session_id, ts) 索引第一天就有（v1 欠账）。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR =
  process.env.SB_DATA_DIR ?? path.join(process.env.APPDATA ?? '.', 'studentbuddy-v2');

let db: Database.Database | null = null;

/** v1 → v2 迁移器暂空缺；M4 迁移工具直接读 v1 库文件，不在此处（不动 v1 原库）。 */
const MIGRATIONS: Array<{ version: number; statements: string[] }> = [
  {
    version: 1,
    statements: [
      // 服务商（key 密文由 storage/crypto 负责）
      `CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT DEFAULT '',
        type TEXT NOT NULL DEFAULT 'openai',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      // 角色绑定（演进①）：五角色各自 provider+model，未配置落默认
      `CREATE TABLE IF NOT EXISTS role_bindings (
        role TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '新对话',
        forked_from_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT,
        tool_call_id TEXT,
        tokens INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      // 搜索缓存（强化包 S2：同查询 TTL 内直回，省免费额度）
      `CREATE TABLE IF NOT EXISTS search_cache (
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'estimated',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
];

// M2：练+析（题库/逐题统计）
MIGRATIONS.push({
  version: 2,
  statements: [
    `CREATE TABLE IF NOT EXISTS quiz_bank (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'ai',
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS quiz_stats (
      quiz_id TEXT NOT NULL,
      question_index INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      last_answer TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (quiz_id, question_index)
    )`,
  ],
});

// M3：忆（SRS 引擎字段与索引）
MIGRATIONS.push({
  version: 3,
  statements: [
    `CREATE TABLE IF NOT EXISTS memorize (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      definition TEXT NOT NULL,
      category TEXT,
      difficulty INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'new',
      ease_factor REAL NOT NULL DEFAULT 2.5,
      interval_days INTEGER NOT NULL DEFAULT 0,
      next_review_at TEXT,
      review_count INTEGER NOT NULL DEFAULT 0,
      lapse_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memorize_due ON memorize(status, next_review_at)`,
  ],
});

// M4：反馈环（活动/每日总结/学习会话）
MIGRATIONS.push({
  version: 4,
  statements: [
    `CREATE TABLE IF NOT EXISTS daily_activity (
      day TEXT NOT NULL,
      type TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, type)
    )`,
    `CREATE TABLE IF NOT EXISTS user_stats (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS daily_summaries (
      day TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ],
});

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, 'studentbuddy.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = d.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number | null };
  const current = row.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const apply = d.transaction(() => {
      for (const stmt of m.statements) d.exec(stmt);
      d.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(m.version);
    });
    apply();
  }
}

/** 测试辅助：用临时目录开独立实例（不污染真实库）。 */
export function openIsolated(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const d = new Database(path.join(dataDir, 'studentbuddy.db'));
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  migrate(d);
  return d;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
