/**
 * storage/db — SQLite 单文件（WAL + 外键），schema_version 逐语句版本化迁移。
 * v2 铁律（ADR-6）：不用大模板字符串批量 exec（v1 TS1434 坑根除）；每版迁移一个数组；
 * 索引与建表同批；messages(session_id, ts) 索引第一天就有（v1 欠账）。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 数据目录解析（ADR-6：不碰用户数据，且**不能静默落到错误位置**）。
 *
 * 优先级：
 *   1. `SB_DATA_DIR` 显式覆盖（测试 / 多实例场景，最高优先级，原样保留）。
 *   2. `APPDATA` / `LOCALAPPDATA`（正常 Windows 终端一定存在）→ 各自下的 `studentbuddy-v2`。
 *   3. **即便上述环境变量缺失**，Windows 上真实数据几乎总在用户目录下的
 *      `AppData/Roaming/studentbuddy-v2`；末位再保留 `os.homedir()/studentbuddy-v2`
 *      这一历史兜底（2026-09-05 引入，防库写进源码树）。
 *
 * ★ 关键修正（根治「反复启动后没数据」）：不再直接拿首个候选去**新建**空库，
 * 而是先扫描候选列表、优先挑**已经存在 `studentbuddy.db` 的那个**真实库。
 * 这样即使启动环境没有 `APPDATA`（CI / 精简 shell / 部分沙箱 Bash，已反复踩到），
 * 也能自动找回真实库，而不是在 homedir 下新建一个空壳库把用户数据「藏起来」。
 * 只有当所有候选都不存在库文件时，才在首个候选处新建。
 */
export function resolveDataDir(): string {
  if (process.env.SB_DATA_DIR) return process.env.SB_DATA_DIR;
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'studentbuddy-v2'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'studentbuddy-v2'));
  candidates.push(path.join(home, 'AppData', 'Roaming', 'studentbuddy-v2'));
  candidates.push(path.join(home, 'studentbuddy-v2')); // 历史兜底（09-05 引入）
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'studentbuddy.db'))) return dir;
  }
  return candidates[0] ?? path.join(home, 'studentbuddy-v2');
}

export const DATA_DIR = resolveDataDir();

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

// M5：忆域重做（2026-09-01 契约）——手动词条+SRS 翻卡废弃，改 AI 自动词条库
//（term_library：对话/搜索中 AI 认为重要的词条自动入库，后续对话注入优先使用）
MIGRATIONS.push({
  version: 5,
  statements: [
    `CREATE TABLE IF NOT EXISTS term_library (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL,
      definition TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'general',
      source_session_id TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(term, domain)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_term_domain ON term_library(domain)`,
    // 旧词条记忆（memorize/SRS）按决策整体废弃：数据清空、表结构保留作迁移记录
    `DELETE FROM memorize`,
  ],
});

// 文档模式（2026-09-02 契约 5.0 §5.1）：会话绑定一篇 txt/md 资料，整篇直塞进 system。
// 只加两列、不建表：资料的生命周期完全随会话，无跨会话检索需求（不做切块/embedding）。
MIGRATIONS.push({
  version: 6,
  statements: [
    `ALTER TABLE sessions ADD COLUMN doc_name TEXT`,
    `ALTER TABLE sessions ADD COLUMN doc_text TEXT`,
  ],
});

// v7：词条库 AI 整理（2026-09-03 契约 TERM-TIDY-SPEC）——同义词归一挂别名列。
// 认知进化契约（COGNITIVE-EVOLUTION-SPEC，待评审）原定 v7 已顺延为 v8。
MIGRATIONS.push({
  version: 7,
  statements: [
    `ALTER TABLE term_library ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'`,
  ],
});

// v8：认知进化（2026-09-02 契约 v1；2026-09-06 v1.1 评审通过落码，SPEC §5）。
// v1.1.1 勘误：evolution_session 加 probe_first 列——§8 POST 的 probeFirst 必须随会话持久化，
// 否则刷新复原的直达会话会丢提问式开场（契约建表时漏列，纯表结构补齐，不动协议与提示词行为）。
// met（v1.1 证据式判定）刻意不落链：仅经 SSE verdict block 做会话内即时反馈，
// 进化链回顾保持 v1 字段集（SPEC §5/§11 TermEvolutionChain）。
MIGRATIONS.push({
  version: 8,
  statements: [
    // 会话的进化模式绑定：一个会话一套选题（与文档模式「生命周期随会话」同构）
    `CREATE TABLE IF NOT EXISTS evolution_session (
      session_id  TEXT PRIMARY KEY,
      term_ids    TEXT NOT NULL,                        -- JSON string[]（term_library.id）
      probe_first INTEGER NOT NULL DEFAULT 0,           -- 词条直达提问式开场（v1.1）
      status      TEXT NOT NULL DEFAULT 'active',       -- active | closed
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // 进化链：每次判定一条 append-only 记录；term 被删也要能回顾，
    // 故冗余 term_text 快照、不设外键（链行独立于词条生命周期）
    `CREATE TABLE IF NOT EXISTS evolution_event (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      term_id    TEXT NOT NULL,
      term_text  TEXT NOT NULL,
      from_level INTEGER NOT NULL,
      to_level   INTEGER NOT NULL,
      verdict    TEXT NOT NULL,      -- AI 评语（面向用户）
      gaps       TEXT,               -- JSON string[] 缺口
      next_goal  TEXT,               -- 下一级目标（L4 时为 null）
      user_say   TEXT NOT NULL,      -- 本轮用户原话（截 2000 字）
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_evo_event_term ON evolution_event(term_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_evo_event_session ON evolution_event(session_id, created_at)`,
    // 等级是词条的属性，不建新表；best_level 只增不减（判定允许降级）
    `ALTER TABLE term_library ADD COLUMN evo_level INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE term_library ADD COLUMN best_level INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE term_library ADD COLUMN evo_updated_at TEXT`,
  ],
});

// v9：可观测地基（可观测与数据飞轮方案，2026-09-06）——event_log 单表落观测事件。
// v8 已被认知进化契约预留（见 v7 注释），本迁移直接取 v9；后续批次从 v10 顺延。
// payload 只存摘要类字段（截断查询词/工具名/错误摘要），不复制消息正文。
MIGRATIONS.push({
  version: 9,
  statements: [
    `CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      session_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT,
      latency_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_event_log_kind_ts ON event_log(kind, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(ts)`,
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

/** 测试辅助：用临时目录开独立实例（不污染真实库）；同时让 getDb() 指向它。 */
export function openIsolated(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const d = new Database(path.join(dataDir, 'studentbuddy.db'));
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  migrate(d);
  db = d;
  return d;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
