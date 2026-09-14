/**
 * storage/migrations — schema_version 逐语句版本化迁移的**唯一定义处**。
 *
 * 从 db.ts 拆出（2026-09-14）：db.ts 已到 414 行、触 AGENTS.md「.ts ≤400 行」红线，
 * 而增行几乎全来自 v1~v14 的建表语句——迁移是**只会单向增长**的清单，
 * 与连接管理（resolveDataDir / getDb / openIsolated）是两种生命周期，故按职责切开。
 * 拆分零行为改动：迁移内容一字未改，只换了个文件放。
 *
 * v2 铁律（ADR-6）：不用大模板字符串批量 exec（v1 TS1434 坑根除）；每版迁移一个数组；
 * 索引与建表同批；messages(session_id, ts) 索引第一天就有（v1 欠账）。
 */
import type Database from 'better-sqlite3';

export const MIGRATIONS: Array<{ version: number; statements: string[] }> = [
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
  // M2：练+析（题库/逐题统计）
  {
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
  },
  // M3：忆（SRS 引擎字段与索引）
  {
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
  },
  // M4：反馈环（活动/每日总结/学习会话）
  {
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
  },
  // M5：忆域重做（2026-09-01 契约）——手动词条+SRS 翻卡废弃，改 AI 自动词条库
  //（term_library：对话/搜索中 AI 认为重要的词条自动入库，后续对话注入优先使用）
  {
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
  },
  // 文档模式（2026-09-02 契约 5.0 §5.1）：会话绑定一篇 txt/md 资料，整篇直塞进 system。
  // 只加两列、不建表：资料的生命周期完全随会话，无跨会话检索需求（不做切块/embedding）。
  {
    version: 6,
    statements: [`ALTER TABLE sessions ADD COLUMN doc_name TEXT`, `ALTER TABLE sessions ADD COLUMN doc_text TEXT`],
  },
  // v7：词条库 AI 整理（2026-09-03 契约 TERM-TIDY-SPEC）——同义词归一挂别名列。
  // 认知进化契约（COGNITIVE-EVOLUTION-SPEC，待评审）原定 v7 已顺延为 v8。
  {
    version: 7,
    statements: [`ALTER TABLE term_library ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'`],
  },
  // v8：认知进化（2026-09-02 契约 v1；2026-09-06 v1.1 评审通过落码，SPEC §5）。
  // v1.1.1 勘误：evolution_session 加 probe_first 列——§8 POST 的 probeFirst 必须随会话持久化，
  // 否则刷新复原的直达会话会丢提问式开场（契约建表时漏列，纯表结构补齐，不动协议与提示词行为）。
  // met（v1.1 证据式判定）刻意不落链：仅经 SSE verdict block 做会话内即时反馈，
  // 进化链回顾保持 v1 字段集（SPEC §5/§11 TermEvolutionChain）。
  {
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
  },
  // v9：可观测地基（可观测与数据飞轮方案，2026-09-06）——event_log 单表落观测事件。
  // v8 已被认知进化契约预留（见 v7 注释），本迁移直接取 v9；后续批次从 v10 顺延。
  // payload 只存摘要类字段（截断查询词/工具名/错误摘要），不复制消息正文。
  {
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
  },
  // v10：PK 登录（2026-09-09 契约 docs/PK-SPEC.md P0-1）——账号 = pk_users 一条记录。
  // openid 现为模拟值（mock_<id>），P1 换真微信授权时只改写入方，表结构与唯一约束已按真 openid 设计。
  {
    version: 10,
    statements: [
      `CREATE TABLE IF NOT EXISTS pk_users (
        id TEXT PRIMARY KEY,
        openid TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
  // v11：过程回放（2026-09-12）——把「思考」与「任务清单」随消息一起落库。
  // 此前两者只活在 SSE 流里（flow.ts 原注释：「推理内容仅流式呈现（不落库）」），
  // 刷新或重开会话即永久丢失；主流（Claude / ChatGPT）把过程归属于那条回答并持久化回放。
  // 与 v1 的 tool_calls 同一口径：**过程属于消息，不属于页面**。
  // reasoning 存原文（思考链是学习场景的答案组成部分）；tasks 存 update_tasks 最后一次的全量 JSON。
  {
    version: 11,
    statements: [`ALTER TABLE messages ADD COLUMN reasoning TEXT`, `ALTER TABLE messages ADD COLUMN tasks TEXT`],
  },
  // v12：刷题笔记（2026-09-13 契约 docs/QUIZ-NOTES-SPEC.md）——每道题一篇结构化笔记。
  // 提交答案即落草稿：question_data/quiz_title 为快照、不设外键，题库删除后笔记仍自洽可读
  //（与 evolution_event 冗余 term_text 同一手法的镜像决策）。心得 body 由用户补写，
  // 重复作答只刷新对错与作答快照，绝不覆盖已写的心得。
  {
    version: 12,
    statements: [
      `CREATE TABLE IF NOT EXISTS quiz_notes (
        id TEXT PRIMARY KEY,
        quiz_id TEXT NOT NULL,
        question_index INTEGER NOT NULL,
        quiz_title TEXT NOT NULL DEFAULT '',
        question_data TEXT NOT NULL,
        my_answer TEXT,
        correct INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(quiz_id, question_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_quiz_notes_updated ON quiz_notes(updated_at)`,
    ],
  },
  // v13：对话体验升级（2026-09-13）——providers.stream_mode 决定一轮回答的呈现形态：
  // 'stream' = 逐字流式（原生 AI，含思考链 / 任务 / 工具全过程）；'once' = 一次性回答
  //（池中 AI：等待期只有「思考中」UI，答案整块上屏）。
  // 存量回填按 type 定位：anthropic（原生协议）保持 'stream'，openai 兼容（中转池）落 'once'
  //——中转池大量按非流式聚合转发，逐字流式体验本就残缺，一次性回答是它们的真实形态。
  {
    version: 13,
    statements: [
      `ALTER TABLE providers ADD COLUMN stream_mode TEXT NOT NULL DEFAULT 'stream'`,
      `UPDATE providers SET stream_mode = 'once' WHERE type = 'openai'`,
    ],
  },
  // v14：方案选择框（2026-09-14 契约 docs/ASK-CHOICE-SPEC.md）——AI 主动提问、用户点选、同轮继续。
  // 独立建表、不塞 messages：选择题是**一轮内的从属交互**，不是消息流的一员（浮层形态，老板拍板）。
  // 落库的唯一理由是「挂起的卡能被重新捞回来」：等待态在后端是内存 Promise，若前端刷新就再也
  // 看不到卡，而工具还在等——体验会断裂成「以为空闲、实则挂起」。故请求与答复都必须持久化。
  // 重启清理见 chat/choice.ts 的 sweepStaleChoices（内存 Promise 随进程消失，库里 pending 必作废）。
  {
    version: 14,
    statements: [
      `CREATE TABLE IF NOT EXISTS ask_choices (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        allow_custom INTEGER NOT NULL DEFAULT 1,
        multi INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        reply_option_id TEXT,
        reply_custom TEXT,
        reply_ts INTEGER,
        cancel_reason TEXT,
        answered_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ask_choices_pending ON ask_choices(session_id, status)`,
    ],
  },
];

/** 逐版本幂等应用：已应用过的（≤ current）跳过；每版一个事务，失败即整体回滚。 */
export function migrate(d: Database.Database): void {
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
