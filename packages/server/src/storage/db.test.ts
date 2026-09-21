import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated } from './db.js';
import { MIGRATIONS } from './migrations-list.js';

/**
 * 迁移清单的**最高版本号**（= 新建库跑完后的 `MAX(schema_version.version)`）。
 *
 * ★ 为什么用算的而不是写死：本仓每加一条迁移都会重放整条链，而"重放后库应处于最新版"
 *   这个断言**每加一条迁移就会红一次**（v31 落地时实测红了一处）。
 *   写死数字等于把「清单头号」抄了一份，多一个会漂移的快照（§0.11）。
 */
const HEAD_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-db-test-'));
}

/**
 * 把 v29（M2c，LLM 成本归主）的三处改动退回「老库」形态。**每个"退版本重放"用例都要调。**
 *
 * 为什么三件事都得做，各自对应一条既有的踩坑：
 *  1. `providers.owner_id` / `token_usage.user_id` 是**加列** ⇒ 必须退列
 *     （`ALTER TABLE ADD COLUMN` 不幂等，本仓已五次踩过 `duplicate column name`）；
 *  2. `role_bindings` 是**重建表** ⇒ 必须退回**旧结构**（`role TEXT PRIMARY KEY` 单列主键）。
 *     留着新表虽然也能重放成功（`INSERT … SELECT` 列都对得上），但那就**测不出"老库升上来"**
 *     这件事本身了——用例名里写的"老库升级"会名不副实；
 *  3. ★ **不能只 `DROP TABLE` 就完事**：`migrate()` 只跑 `version > current` 的迁移，
 *     被跳过的 v1（`CREATE TABLE IF NOT EXISTS role_bindings`）**不会再把表建回来** ⇒
 *     只删不建会让整条链后面全报 "no such table: role_bindings"。故这里 DROP 完立刻按旧结构建回。
 */
function revertV29(db: ReturnType<typeof openIsolated>): void {
  db.exec(`ALTER TABLE providers DROP COLUMN owner_id`);
  db.exec(`ALTER TABLE token_usage DROP COLUMN user_id`);
  db.exec(`DROP TABLE IF EXISTS role_bindings`);
  db.exec(`CREATE TABLE role_bindings (role TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL)`);
}

/**
 * 把 v30（M2d-1，设置与反馈环归主）的**四张重建表**退回「老库」形态。
 *
 * ★ 四张全是**重建**（不是加列）⇒ 退回动作统一是「DROP 新表 + 按旧结构建回」。
 *   **不能只 DROP**：`migrate()` 只跑 `version > current` 的迁移，被跳过的 v1
 *   （`CREATE TABLE IF NOT EXISTS`）不会重跑 ⇒ 只删不建，后面整条链全报 `no such table`
 *   （v29 的 `revertV29` 已踩过这一条，见上面的注释）。
 * ★ 旧结构逐字取自 `migrations-list-v1-9.ts`，**不要凭印象写**：`daily_summaries.created_at`
 *   那个 `DEFAULT (datetime('now'))` 少写一个括号都算「与老库不一致」，用例会测出假的差异。
 */
function revertV30(db: ReturnType<typeof openIsolated>): void {
  db.exec(`DROP TABLE IF EXISTS app_settings`);
  db.exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`DROP TABLE IF EXISTS daily_activity`);
  db.exec(`CREATE TABLE daily_activity (
    day TEXT NOT NULL,
    type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, type)
  )`);
  db.exec(`DROP TABLE IF EXISTS daily_summaries`);
  db.exec(`CREATE TABLE daily_summaries (
    day TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec(`DROP TABLE IF EXISTS user_stats`);
  db.exec(`CREATE TABLE user_stats (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

/**
 * 把 v32（P1 计时呈现线，契约 TOOL-ECOSYSTEM-SPEC §4.7）的两处加列退回「老库」形态。
 * **每个"退版本重放"用例都要调**（v32 落在链尾 ⇒ 只要退到的版本 < 32 就要退列）。
 *
 * ★ 两列都是**纯加列**（`messages.thinking_ms` / `messages.duration_ms`，无索引无约束）
 *   ⇒ 退回动作只有 DROP，无需建回（对比 v29/v30 的「DROP 后按旧结构建回」）。
 * ★ 回放纪律同 v28：`ALTER TABLE ADD COLUMN` 不幂等，漏退一列，重放整条链时
 *   v32 的 ADD COLUMN 就报 `duplicate column name`（本仓第六次踩同一坑，见 v11 用例内注释）。
 */
function revertV32(db: ReturnType<typeof openIsolated>): void {
  db.exec(`ALTER TABLE messages DROP COLUMN thinking_ms`);
  db.exec(`ALTER TABLE messages DROP COLUMN duration_ms`);
}

/**
 * 把 v33（M2d-3 其余表归主）的八处加列退回「老库」形态。**每个"退版本重放"用例都要调**
 * （v33 落在链尾 ⇒ 只要退到的版本 < 33 就要退列）。八列全是 `NOT NULL DEFAULT ''` 的纯加列
 * （无索引无外键）⇒ 退回动作只有 DROP；漏退一列，重放整条链时 v33 的 ADD COLUMN 就报
 * `duplicate column name`（同 v28/v32 的第七次先例，见 v11 用例内注释）。
 */
function revertV33(db: ReturnType<typeof openIsolated>): void {
  db.exec(`ALTER TABLE quiz_bank DROP COLUMN owner_id`);
  db.exec(`ALTER TABLE quiz_stats DROP COLUMN owner_id`);
  db.exec(`ALTER TABLE quiz_notes DROP COLUMN owner_id`);
  db.exec(`ALTER TABLE flow_def DROP COLUMN owner_id`);
  db.exec(`ALTER TABLE flow_run DROP COLUMN owner_id`);
  db.exec(`ALTER TABLE flow_run_step DROP COLUMN owner_id`);
  db.exec(`ALTER TABLE knowledge_node DROP COLUMN owner_id`);
  db.exec(`ALTER TABLE knowledge_edge DROP COLUMN owner_id`);
}

/**
 * 把 v36（GitHub OAuth 登录，契约 docs/AUTH-SPEC.md §2.8）的 users 加列退回「老库」形态。
 * **每个"退版本重放"用例都要调**（v36 落在链尾 ⇒ 只要退到的版本 < 36 就要退）。
 * ★ 可空加列 + 部分唯一索引 ⇒ 退回动作 = DROP INDEX + DROP COLUMN；漏退一者，
 *   重放整条链时分别撞 `duplicate column name`（ADD COLUMN 不幂等的第八次先例）。
 */
function revertV36(db: ReturnType<typeof openIsolated>): void {
  db.exec(`DROP INDEX IF EXISTS idx_users_github_id`);
  db.exec(`ALTER TABLE users DROP COLUMN github_id`);
}

/**
 * 把 v38（「向 AI 追问」的根词条，契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §2）的加列退回「老库」形态。
 * **每个"退版本重放"用例都要调**（v38 落在链尾 ⇒ 只要退到的版本 < 38 就要退列）。
 *
 * ★ 单列、`TEXT` 可空、无索引无约束 ⇒ 退回动作只有 `DROP COLUMN`（对比 v29/v30 的
 *   「DROP 后按旧结构建回」）——`sessions` 表本身在 v1 就建好了，不需要补建。
 * ★ 漏退这一列，重放整条链时 v38 的 `ADD COLUMN` 就报 `duplicate column name`
 *   （本仓**第九次**踩同一坑，见 v11 用例内注释；第八次是 v36 的 `users.github_id`）。
 */
function revertV38(db: ReturnType<typeof openIsolated>): void {
  db.exec(`ALTER TABLE sessions DROP COLUMN forked_term`);
}

/**
 * 把 v39（平台免费通道的调用次数用量，契约见 `llm/platform-quota.ts`）的建表退回「老库」形态。
 *
 * ★ 与 v38 那类加列**不同**：本版是 `CREATE TABLE IF NOT EXISTS`，**幂等**，故
 *   **既有的退版本重放用例不必调本函数**（退到 v36 重放时表已存在，语句直接跳过，不报错）。
 *   唯一需要它的地方是「想证明 v39 确实建了这张表」的用例——不先 DROP，表是建库时留下的，
 *   "重放建回"就是句空话（同 `revertV29` 注释里第 2 条的道理）。
 * ★ 索引随 `DROP TABLE` 一并消失（SQLite 会连带删掉该表上的索引），无需单独 DROP INDEX。
 */
function revertV39(db: ReturnType<typeof openIsolated>): void {
  db.exec(`DROP TABLE IF EXISTS platform_usage`);
}

/**
 * 把 v40（GitHub 独立建号，契约 `docs/AUTH-SPEC.md` §2.8 口径 1）的加列退回「老库」形态。
 * **每个"退版本重放"用例都要调**（v40 落在链尾 ⇒ 只要退到的版本 < 40 就要退列）。
 *
 * ★ 单列、`TEXT` 可空、**无索引无约束** ⇒ 退回动作只有 `DROP COLUMN`，无需建回
 *   （对比 v29/v30 的「DROP 后按旧结构建回」）——`users` 表在 v1 就建好了。
 * ★ 漏退这一列，重放整条链时 v40 的 `ADD COLUMN` 就报 `duplicate column name`
 *   （本仓**第十次**踩同一坑，见 v11 用例内注释；第九次是 v38 的 `sessions.forked_term`）。
 * ★ **与 v36 刻意不同**：v36 除加列外还带一个部分唯一索引，退的时候必须先 `DROP INDEX`；
 *   本版只有一列、**没有索引** ⇒ 别照抄 v36 多写一句 `DROP INDEX`（那会掩盖「本版无索引」这回事，
 *   下次有人读到会以为有个索引要维护）。
 */
function revertV40(db: ReturnType<typeof openIsolated>): void {
  db.exec(`ALTER TABLE users DROP COLUMN github_email`);
}

describe('storage/db — 版本化迁移（逐语句，根除 v1 大模板 TS1434 坑）', () => {
  it('建表齐全 + schema_version 记录 + 幂等（重复打开不动）', () => {
    const dir = tmp();
    const db = openIsolated(dir);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of ['providers', 'role_bindings', 'sessions', 'messages', 'app_settings', 'search_cache', 'token_usage', 'schema_version']) {
      expect(tables).toContain(t);
    }
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(1);

    const db2 = openIsolated(dir); // 幂等
    const v2 = db2.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v2.v).toBe(v.v);
    db.close();
    db2.close();
  });

  it('messages(session_id, created_at) 索引第一天就有（v1 欠账补齐）', () => {
    const db = openIsolated(tmp());
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_session_ts'`).get();
    expect(idx).toBeTruthy();
    db.close();
  });

  it('外键生效（session 不存在时插入 message 报错）', () => {
    const db = openIsolated(tmp());
    expect(() => {
      db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES ('m1', 'nope', 'user', 'x')`).run();
    }).toThrow();
    db.close();
  });
});

describe('storage/db — v8 深度理解迁移（DEEP-UNDERSTANDING-SPEC §5，v1.1 落码）', () => {
  it('evolution_session / evolution_event 两表与两索引建齐', () => {
    const db = openIsolated(tmp());
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('evolution_session');
    expect(tables).toContain('evolution_event');
    for (const ix of ['idx_evo_event_term', 'idx_evo_event_session']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(ix)).toBeTruthy();
    }
    db.close();
  });

  it('term_library 深度理解列默认值：evo_level=0 / best_level=0 / evo_updated_at NULL', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO term_library (id, term, definition) VALUES ('t1', '闭包', '函数记住外部变量')`).run();
    const row = db
      .prepare(`SELECT evo_level, best_level, evo_updated_at FROM term_library WHERE id='t1'`)
      .get() as { evo_level: number; best_level: number; evo_updated_at: string | null };
    expect(row.evo_level).toBe(0);
    expect(row.best_level).toBe(0);
    expect(row.evo_updated_at).toBeNull();
    db.close();
  });

  it('evolution_event 抗删词条：term_id 不在库也能落链行（term_text 快照，刻意无外键）', () => {
    const db = openIsolated(tmp());
    db.prepare(
      `INSERT INTO evolution_event (id, session_id, term_id, term_text, from_level, to_level, verdict, user_say)
       VALUES ('e1', 's1', 'gone-term', '闭包', 1, 2, '要素完整', '闭包就是……')`,
    ).run();
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM evolution_event WHERE term_id='gone-term'`).get() as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });

  it('evolution_session.probe_first 默认 0、status 默认 active（v1.1 勘误列）', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO evolution_session (session_id, term_ids) VALUES ('s1', '["t1"]')`).run();
    const row = db
      .prepare(`SELECT probe_first, status FROM evolution_session WHERE session_id='s1'`)
      .get() as { probe_first: number; status: string };
    expect(row.probe_first).toBe(0);
    expect(row.status).toBe('active');
    db.close();
  });
});

describe('storage/db — v11 过程回放迁移（思考链 / 任务清单随消息落库）', () => {
  const cols = (db: ReturnType<typeof openIsolated>): string[] =>
    (db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((c) => c.name);

  it('新库的 messages 含 reasoning / tasks 两列', () => {
    const db = openIsolated(tmp());
    expect(cols(db)).toEqual(expect.arrayContaining(['reasoning', 'tasks']));
    db.close();
  });

  it('老库升级：删列并把版本退回 10，重开后各版本列自动补回（旧用户不掉过程/配置）', () => {
    const dir = tmp();
    const v10 = openIsolated(dir);
    // 列随 v11（messages 过程回放）/ v13（providers.stream_mode）新增：退版本时连列一起退，
    // 重开后整条迁移链重放，两处都必须自动补回
    v10.exec(`ALTER TABLE messages DROP COLUMN reasoning`);
    v10.exec(`ALTER TABLE messages DROP COLUMN tasks`);
    v10.exec(`ALTER TABLE providers DROP COLUMN stream_mode`);
    // v16 长期记忆（sessions 四列）同理：SQLite 的 ADD COLUMN **不幂等**，
    // 退版本号就得连列一起退，否则迁移链重放到 v16 会撞 `duplicate column name`
    v10.exec(`ALTER TABLE sessions DROP COLUMN summary`);
    v10.exec(`ALTER TABLE sessions DROP COLUMN summary_upto_rowid`);
    v10.exec(`ALTER TABLE sessions DROP COLUMN summary_tokens`);
    v10.exec(`ALTER TABLE sessions DROP COLUMN summary_updated_at`);
    // v17 看图（messages.images）：同上，每加一列迁移，退版本的用例都要跟着多退一列
    v10.exec(`ALTER TABLE messages DROP COLUMN images`);
    // v22 多租户（sessions.user_id）：同上，每加一列迁移，退版本的用例都要跟着多退一列。
    // ★ **先删索引再删列**：该列上有 idx_sessions_user，直接 DROP COLUMN 会报
    //   "error in index ... after drop column"（SQLite 不留悬空索引）
    v10.exec(`DROP INDEX IF EXISTS idx_sessions_user`);
    v10.exec(`ALTER TABLE sessions DROP COLUMN user_id`);
    // v23 复习（term_library 两列 + term_review_log）：同上，多一列迁移就多退一列。
    // ★ 先删索引再删列（idx_term_library_last_reviewed 建在 last_reviewed_at 上，
    //   SQLite 不留悬空索引，直接 DROP COLUMN 会报 "error in index ... after drop column"）
    v10.exec(`DROP INDEX IF EXISTS idx_term_library_last_reviewed`);
    v10.exec(`ALTER TABLE term_library DROP COLUMN review_stage`);
    v10.exec(`ALTER TABLE term_library DROP COLUMN last_reviewed_at`);
    // v28 复习范围（term_library 一列 + term_domain 一列）：同 v23，多一列迁移就多退一列。
    // ★ 先删索引再删列（idx_term_library_review_enabled 建在新列上，SQLite 不留悬空索引）
    v10.exec(`DROP INDEX IF EXISTS idx_term_library_review_enabled`);
    v10.exec(`ALTER TABLE term_library DROP COLUMN review_enabled`);
    v10.exec(`ALTER TABLE term_domain DROP COLUMN review_enabled`);
    v10.exec(`DROP TABLE IF EXISTS term_review_log`);
    // v25 督促流水（coach_messages）：CREATE TABLE IF NOT EXISTS 不 DROP 也能重放，
    // 但留着就等于"老库其实已经有督促流水"，与测试意图不符（同 v23 那条的理由）
    v10.exec(`DROP TABLE IF EXISTS coach_messages`);
    // v26 提及流水（term_mention_log）：同 v25 的理由——纯建表型迁移回放本身安全
    // （见 migrations-list-v22.ts 文件头第 11-12 行），但留着会让"老库"凭空有流水。
    v10.exec(`DROP TABLE IF EXISTS term_mention_log`);
    // v27 邮箱验证码（auth_codes）：同 v25/v26 的理由（纯建表型，回放无需 DROP 列）
    v10.exec(`DROP TABLE IF EXISTS auth_codes`);
    revertV29(v10);
    revertV32(v10);
    revertV33(v10);
    revertV36(v10);
    revertV38(v10);
    revertV40(v10);
    v10.prepare('DELETE FROM schema_version WHERE version > 10').run();
    expect(cols(v10)).not.toContain('reasoning');
    v10.close();

    const upgraded = openIsolated(dir);
    expect(cols(upgraded)).toEqual(expect.arrayContaining(['reasoning', 'tasks']));
    expect((upgraded.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBeGreaterThanOrEqual(
      11,
    );
    upgraded.close();
  });
});

describe('storage/db — v13 回答形态迁移（providers.stream_mode）', () => {
  it('新库 providers 含 stream_mode 列', () => {
    const db = openIsolated(tmp());
    const cols = (db.prepare(`PRAGMA table_info(providers)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('stream_mode');
    db.close();
  });

  it('老库回填按 type 定位：openai 兼容（池中）→ once，anthropic（原生）→ stream', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    old.prepare(`INSERT INTO providers (id, name, base_url, type, enabled) VALUES ('p-ai', '池', 'https://relay/v1', 'openai', 1)`).run();
    old.prepare(
      `INSERT INTO providers (id, name, base_url, type, enabled) VALUES ('p-native', '原生', 'https://api.anthropic.com/v1', 'anthropic', 1)`,
    ).run();
    old.exec(`ALTER TABLE providers DROP COLUMN stream_mode`);
    // v16 的 sessions 四列同样要退（ADD COLUMN 不幂等，见上一个用例的说明）
    old.exec(`ALTER TABLE sessions DROP COLUMN summary`);
    old.exec(`ALTER TABLE sessions DROP COLUMN summary_upto_rowid`);
    old.exec(`ALTER TABLE sessions DROP COLUMN summary_tokens`);
    old.exec(`ALTER TABLE sessions DROP COLUMN summary_updated_at`);
    // v17 看图（messages.images）：同上
    old.exec(`ALTER TABLE messages DROP COLUMN images`);
    // v22 多租户（sessions.user_id）：同上（先删索引再删列，理由见上一个用例）
    old.exec(`DROP INDEX IF EXISTS idx_sessions_user`);
    old.exec(`ALTER TABLE sessions DROP COLUMN user_id`);
    // v23 复习：同上（先索引后列）
    old.exec(`DROP INDEX IF EXISTS idx_term_library_last_reviewed`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_stage`);
    old.exec(`ALTER TABLE term_library DROP COLUMN last_reviewed_at`);
    // v28 复习范围（term_library 一列 + term_domain 一列）：同 v23，多一列迁移就多退一列。
    // ★ 先删索引再删列（idx_term_library_review_enabled 建在新列上，SQLite 不留悬空索引）
    old.exec(`DROP INDEX IF EXISTS idx_term_library_review_enabled`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_enabled`);
    old.exec(`ALTER TABLE term_domain DROP COLUMN review_enabled`);
    old.exec(`DROP TABLE IF EXISTS term_review_log`);
    // v25 督促流水：同上
    old.exec(`DROP TABLE IF EXISTS coach_messages`);
    revertV29(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 12').run();
    old.close();

    const upgraded = openIsolated(dir);
    const modes = upgraded.prepare('SELECT id, stream_mode FROM providers ORDER BY id').all() as Array<{
      id: string;
      stream_mode: string;
    }>;
    expect(modes).toEqual([
      { id: 'p-ai', stream_mode: 'once' },
      { id: 'p-native', stream_mode: 'stream' },
    ]);
    upgraded.close();
  });
});

describe('storage/db — v16 长期记忆迁移（docs/MEMORY-SPEC.md）', () => {
  it('新库 sessions 含四个摘要列，user_memory 表与 idx_memory_kind 索引就位', () => {
    const db = openIsolated(tmp());
    const sCols = (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(sCols).toEqual(
      expect.arrayContaining(['summary', 'summary_upto_rowid', 'summary_tokens', 'summary_updated_at']),
    );

    const mCols = (db.prepare(`PRAGMA table_info(user_memory)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(mCols).toEqual(
      expect.arrayContaining(['id', 'kind', 'content', 'source_session_id', 'importance', 'usage_count', 'last_used_at']),
    );

    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_kind'`).all();
    expect(idx).toHaveLength(1);
    db.close();
  });

  it('UNIQUE(kind, content) 在库层兜底（写入侧过滤之外的第二道）', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO user_memory (id, kind, content) VALUES ('a', 'profile', '同一句')`).run();
    expect(() =>
      db.prepare(`INSERT INTO user_memory (id, kind, content) VALUES ('b', 'profile', '同一句')`).run(),
    ).toThrow();
    db.close();
  });
});

describe('storage/db — v24 长期画像归主（docs/TENANCY-SPEC.md §7）', () => {
  it('唯一键是 (user_id, kind, content)：同人重复才撞，★ 同内容不同人必须能共存', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO user_memory (id, user_id, kind, content) VALUES ('a', 'u-1', 'profile', '同一句')`).run();
    expect(() =>
      db.prepare(`INSERT INTO user_memory (id, user_id, kind, content) VALUES ('b', 'u-1', 'profile', '同一句')`).run(),
    ).toThrow();

    // ★ 这一行是 v24 的**全部理由**：v24 之前唯一键是 `UNIQUE(kind, content)`（全局），
    //   这里会撞——而上层 `ON CONFLICT DO UPDATE` 会把 u-1 那行**改写**（B 的隐私落进 A 的行里）。
    db.prepare(`INSERT INTO user_memory (id, user_id, kind, content) VALUES ('c', 'u-2', 'profile', '同一句')`).run();
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM user_memory WHERE content = '同一句'`).get() as { c: number }).c;
    expect(n).toBe(2);
    db.close();
  });

  it(`user_id NOT NULL DEFAULT ''：无主行写得进，且不落进任何登录用户的名下`, () => {
    const db = openIsolated(tmp());
    const info = (
      db.prepare(`PRAGMA table_info(user_memory)`).all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>
    ).find((c) => c.name === 'user_id');
    // ★ 用列而非 `COALESCE(user_id,'')` 表达式索引：`ON CONFLICT` 的冲突目标必须匹配
    //   唯一索引的**列**，表达式索引会让它退化成"无冲突目标"而直接报错（写 upsert 时会炸）。
    expect(info?.notnull).toBe(1);
    expect(info?.dflt_value).toBe(`''`);

    db.prepare(`INSERT INTO user_memory (id, kind, content) VALUES ('orphan', 'profile', '无主画像')`).run();
    const mine = (db.prepare(`SELECT COUNT(*) AS c FROM user_memory WHERE user_id = 'u-1'`).get() as { c: number }).c;
    expect(mine).toBe(0); // 无主行不会被判给任何登录用户（与 §3 的孤儿行同口径）
    db.close();
  });

  it('老库升级：既有画像不丢，且被标成无主——★ 绝不判给"第一个注册的人"', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    // 伪装成 v24 之前的库：还原旧表结构（无 user_id、全局 UNIQUE）并塞一行老画像。
    // 只退到 v23 是因为 v23 的 `ALTER TABLE term_library ADD COLUMN` 不幂等，重放会撞 duplicate column。
    old.exec(`DROP TABLE IF EXISTS user_memory`);
    old.exec(`CREATE TABLE user_memory (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_session_id TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(kind, content)
      )`);
    old.prepare(`INSERT INTO user_memory (id, kind, content, importance) VALUES ('legacy', 'profile', '升级前的画像', 0.7)`).run();
    // v28 复习范围：本用例只退到 v23（v23 与 v28 的 ADD COLUMN 都不幂等），
    // 故 v28 的两列要单独退；先删索引再删列（SQLite 不留悬空索引）。
    old.exec(`DROP INDEX IF EXISTS idx_term_library_review_enabled`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_enabled`);
    old.exec(`ALTER TABLE term_domain DROP COLUMN review_enabled`);
    revertV29(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 23').run();
    old.close();

    const upgraded = openIsolated(dir);
    const row = upgraded
      .prepare(`SELECT id, user_id, importance FROM user_memory WHERE id = 'legacy'`)
      .get() as { id: string; user_id: string; importance: number } | undefined;
    expect(row).toBeDefined(); // 数据不丢
    expect(row?.user_id).toBe(''); // 无主（要显式认领，见 _probe/claim-legacy.mjs）
    expect(row?.importance).toBe(0.7); // 其余字段原样搬运
    upgraded.close();
  });
});

describe('storage/db — v12 刷题笔记迁移（docs/QUIZ-NOTES-SPEC.md）', () => {
  it('新库含 quiz_notes 表：UNIQUE(quiz_id, question_index) 与 updated_at 索引就位', () => {
    const db = openIsolated(tmp());
    const cols = (db.prepare(`PRAGMA table_info(quiz_notes)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'quiz_id', 'question_index', 'quiz_title', 'question_data', 'my_answer', 'correct', 'body']),
    );
    // UNIQUE 冲突目标存在，upsert（ON CONFLICT(quiz_id, question_index)）才有落点
    expect(() =>
      db
        .prepare(`INSERT INTO quiz_notes (id, quiz_id, question_index, question_data) VALUES ('n1', 'q1', 0, '{}')`)
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare(`INSERT INTO quiz_notes (id, quiz_id, question_index, question_data) VALUES ('n2', 'q1', 0, '{}')`)
        .run(),
    ).toThrow(/UNIQUE/);
    const idx = db.prepare(`PRAGMA index_list(quiz_notes)`).all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toContain('idx_quiz_notes_updated');
    db.close();
  });
});

describe('storage/db — v19 领域表迁移（term_domain，领域升为一等实体）', () => {
  it('新库含 term_domain 表（name 主键 + note）并**预置 general**', () => {
    const db = openIsolated(tmp());
    const cols = (db.prepare(`PRAGMA table_info(term_domain)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['name', 'note', 'created_at', 'updated_at']));
    // general 是删域时的迁移终点（removeDomain 拒绝删它），必须一建库就在位——
    // 缺了它，删任何领域都会把词条迁进一个"从未登记过"的域，破坏 v19 不变式
    const names = (db.prepare('SELECT name FROM term_domain').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('general');
    db.close();
  });

  it('老库升级回填：词条用过的领域自动登记（v19 纯加法，重放迁移链无需 DROP 列）', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    // 绕过写入侧登记直接落一行（模拟 v19 之前的老库：有词条、无登记册）
    old.prepare(`INSERT INTO term_library (id, term, definition, domain) VALUES ('t1', '闭包', 'x', 'math')`).run();
    old.exec(`DROP TABLE term_domain`); // 退版本号就得连表一起退（CREATE TABLE IF NOT EXISTS 会跳过已存在的表）
    // v22 的 sessions.user_id 是 **ALTER TABLE ADD COLUMN**（不幂等），退到 v18 重放会撞
    // `duplicate column name` ⇒ 连索引带列一起退（先索引后列，SQLite 不留悬空索引）
    old.exec(`DROP INDEX IF EXISTS idx_sessions_user`);
    old.exec(`ALTER TABLE sessions DROP COLUMN user_id`);
    // v23 复习：同上（先索引后列；term_review_log 是 CREATE TABLE IF NOT EXISTS，
    // 不 DROP 也能重放，但留着就等于"老库其实已经有复习流水"，与测试意图不符）
    old.exec(`DROP INDEX IF EXISTS idx_term_library_last_reviewed`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_stage`);
    old.exec(`ALTER TABLE term_library DROP COLUMN last_reviewed_at`);
    // v28 复习范围（term_library 一列 + term_domain 一列）：同 v23，多一列迁移就多退一列。
    // ★ 先删索引再删列（idx_term_library_review_enabled 建在新列上，SQLite 不留悬空索引）
    old.exec(`DROP INDEX IF EXISTS idx_term_library_review_enabled`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_enabled`);
    // term_domain 在本用例里是整表 DROP 的（v19 回放要重放建表），列随之消失，无需单独退列
    old.exec(`DROP TABLE IF EXISTS term_review_log`);
    // v25 督促流水：同上
    old.exec(`DROP TABLE IF EXISTS coach_messages`);
    revertV29(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 18').run();
    old.close();

    const upgraded = openIsolated(dir);
    const names = (upgraded.prepare('SELECT name FROM term_domain ORDER BY name').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(names).toContain('math'); // 回填：老库的既有领域不丢
    expect(names).toContain('general'); // 预置：默认域重新在位
    upgraded.close();
  });
});

describe('storage/db — v21 账号与会话迁移（docs/AUTH-SPEC.md，M1）', () => {
  it('新库含 users / auth_sessions 两表与两索引', () => {
    const db = openIsolated(tmp());
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('users');
    expect(tables).toContain('auth_sessions');
    for (const ix of ['idx_auth_sessions_user', 'idx_auth_sessions_expires']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(ix)).toBeTruthy();
    }
    db.close();
  });

  it('users.email UNIQUE 由库层兜底（同一邮箱第二行必撞，不靠应用记得查重）', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO users (id, email, password_hash) VALUES ('u1', 'a@b.com', 'h')`).run();
    expect(() =>
      db.prepare(`INSERT INTO users (id, email, password_hash) VALUES ('u2', 'a@b.com', 'h')`).run(),
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it('auth_sessions 主键是 token_hash（同值不能落两行 ⇒ 库里只存哈希不会是摆设）', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, last_seen_at) VALUES ('h1', 'u1', 1, 1)`).run();
    expect(() =>
      db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, last_seen_at) VALUES ('h1', 'u2', 1, 1)`).run(),
    ).toThrow();
    db.close();
  });
});

describe('storage/db — v22 多租户归属迁移（docs/TENANCY-SPEC.md，M2a）', () => {
  const sessionCols = (db: ReturnType<typeof openIsolated>): string[] =>
    (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name);

  it('新库 sessions 含 user_id 列与 idx_sessions_user 索引', () => {
    const db = openIsolated(tmp());
    expect(sessionCols(db)).toContain('user_id');
    // 索引必须存在：WHERE user_id = ? 是此后最高频过滤条件，无索引则会话一多就全表扫
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_user'`).get()).toBeTruthy();
    db.close();
  });

  it('子表不加 user_id（归属唯一事实源，防 sessions/messages 两列漂移）', () => {
    const db = openIsolated(tmp());
    const msgCols = (db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(msgCols).not.toContain('user_id'); // TENANCY-SPEC §1：子表随父表
    db.close();
  });

  it('老库升级：既有会话的 user_id 为 NULL（孤儿行），且对任何已登录用户都查不到', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO sessions (id, title) VALUES ('s-old', '老会话')`).run();
    db.prepare(`INSERT INTO sessions (id, user_id, title) VALUES ('s-a', 'u1', 'A 的会话')`).run();
    expect((db.prepare('SELECT user_id FROM sessions WHERE id = ?').get('s-old') as { user_id: string | null }).user_id).toBeNull();

    // ★ 这条是「上线不泄露」的库层证明：NULL 不匹配任何 user_id = ?，
    //   ⇒ 老数据不会被判给任何一个登录用户（代价是主人也暂时看不到，需显式认领）
    const seenByU1 = db.prepare('SELECT id FROM sessions WHERE deleted_at IS NULL AND user_id = ?').all('u1') as Array<{ id: string }>;
    expect(seenByU1.map((r) => r.id)).toEqual(['s-a']);
    const seenByU2 = db.prepare('SELECT id FROM sessions WHERE deleted_at IS NULL AND user_id = ?').all('u2') as Array<{ id: string }>;
    expect(seenByU2).toEqual([]);
    db.close();
  });
});

describe('storage/db — v23 词条复习迁移（docs/EBBINGHAUS-SPEC.md，艾宾浩斯）', () => {
  const termCols = (db: ReturnType<typeof openIsolated>): string[] =>
    (db.prepare(`PRAGMA table_info(term_library)`).all() as Array<{ name: string }>).map((c) => c.name);

  it('新库 term_library 两列 + term_review_log 表 + 三个索引就位', () => {
    const db = openIsolated(tmp());
    expect(termCols(db)).toEqual(expect.arrayContaining(['review_stage', 'last_reviewed_at']));
    const logCols = (db.prepare(`PRAGMA table_info(term_review_log)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(logCols).toEqual(
      expect.arrayContaining(['id', 'term_id', 'stage', 'remembered', 'reviewed_at', 'reviewed_day']),
    );
    for (const ix of ['idx_term_review_log_term', 'idx_term_review_log_day', 'idx_term_library_last_reviewed']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(ix)).toBeTruthy();
    }
    db.close();
  });

  it('★ 不落 next_review_at：下次复习时间是派生值，落库则改间隔序列就得洗全表', () => {
    const db = openIsolated(tmp());
    expect(termCols(db)).not.toContain('next_review_at');
    db.close();
  });

  it('老库升级：既有词条 review_stage=0 且 last_reviewed_at 为 NULL（= 从未复习，不是「很久前复习过」）', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    old.prepare(`INSERT INTO term_library (id, term, definition, domain) VALUES ('t1', '闭包', 'x', 'math')`).run();
    old.exec(`DROP INDEX IF EXISTS idx_term_library_last_reviewed`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_stage`);
    old.exec(`ALTER TABLE term_library DROP COLUMN last_reviewed_at`);
    // v28 复习范围（term_library 一列 + term_domain 一列）：同 v23，多一列迁移就多退一列。
    // ★ 先删索引再删列（idx_term_library_review_enabled 建在新列上，SQLite 不留悬空索引）
    old.exec(`DROP INDEX IF EXISTS idx_term_library_review_enabled`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_enabled`);
    old.exec(`ALTER TABLE term_domain DROP COLUMN review_enabled`);
    old.exec(`DROP TABLE IF EXISTS term_review_log`);
    revertV29(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 22').run();
    old.close();

    const upgraded = openIsolated(dir);
    const row = upgraded.prepare('SELECT review_stage, last_reviewed_at FROM term_library WHERE id = ?').get('t1') as {
      review_stage: number;
      last_reviewed_at: string | null;
    };
    // 老词条不该"一升级就变成复习过"，也不该"一升级就逾期很久"：起算点退到 created_at 由应用层判
    expect(row.review_stage).toBe(0);
    expect(row.last_reviewed_at).toBeNull();
    upgraded.close();
  });
});

describe('storage/db — v25 督促小窗流水迁移（docs/COACH-SPEC.md，B+C+E 批）', () => {
  const coachCols = (db: ReturnType<typeof openIsolated>): string[] =>
    (db.prepare(`PRAGMA table_info(coach_messages)`).all() as Array<{ name: string }>).map((c) => c.name);

  it('新库 coach_messages 六列 + idx_coach_owner 索引就位', () => {
    const db = openIsolated(tmp());
    expect(coachCols(db)).toEqual(expect.arrayContaining(['id', 'owner_id', 'kind', 'content', 'meta', 'created_at']));
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_coach_owner'`).get()).toBeTruthy();
    db.close();
  });

  it('★ owner_id 允许为 NULL 且无 DEFAULT（未登录单人本地模式 ≠ 空串用户）', () => {
    const db = openIsolated(tmp());
    const info = (db.prepare(`PRAGMA table_info(coach_messages)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((c) => c.name === 'owner_id');
    expect(info?.notnull).toBe(0);
    expect(info?.dflt_value).toBeNull();
    // 真写一行：无主消息必须落得进去（本地单人模式下 ownerId 恒为 null）
    db.prepare(`INSERT INTO coach_messages (id, owner_id, kind, content) VALUES ('m1', NULL, 'ai', '该背了')`).run();
    expect((db.prepare('SELECT COUNT(*) AS c FROM coach_messages').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('老库升级：新表与索引自动补回（重放迁移链不撞 duplicate）', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    old.exec(`DROP TABLE IF EXISTS coach_messages`);
    // v28 复习范围：本用例只退到 v23（v23 与 v28 的 ADD COLUMN 都不幂等），
    // 故 v28 的两列要单独退；先删索引再删列（SQLite 不留悬空索引）。
    old.exec(`DROP INDEX IF EXISTS idx_term_library_review_enabled`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_enabled`);
    old.exec(`ALTER TABLE term_domain DROP COLUMN review_enabled`);
    revertV29(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 23').run();
    old.close();

    const upgraded = openIsolated(dir);
    expect(coachCols(upgraded)).toContain('kind');
    expect(
      upgraded.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_coach_owner'`).get(),
    ).toBeTruthy();
    upgraded.close();
  });
});

describe('storage/db — v27 邮箱验证码迁移（docs/AUTH-SPEC.md §1，M1.5）', () => {
  const codeCols = (db: ReturnType<typeof openIsolated>): Array<{ name: string; type: string; pk: number; notnull: number; dflt_value: string | null }> =>
    db.prepare(`PRAGMA table_info(auth_codes)`).all() as Array<{
      name: string;
      type: string;
      pk: number;
      notnull: number;
      dflt_value: string | null;
    }>;

  it('新库 auth_codes 八列 + idx_auth_codes_email_purpose 索引就位', () => {
    const db = openIsolated(tmp());
    expect(codeCols(db).map((c) => c.name)).toEqual([
      'id',
      'email',
      'code_hash',
      'purpose',
      'expires_at',
      'attempts',
      'consumed_at',
      'created_at',
    ]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_auth_codes_email_purpose'`).get()).toBeTruthy();
    db.close();
  });

  it('★ 主键是**自增 INTEGER**、不是 email——同一邮箱多次发码必须能**留下多行**', () => {
    const db = openIsolated(tmp());
    const id = codeCols(db).find((c) => c.name === 'id');
    expect(id?.pk).toBe(1);
    expect(id?.type).toBe('INTEGER'); // AUTOINCREMENT 要求 INTEGER 主键
    // 契约 §1 的核心依据：以 email 为主键就只能覆盖，旧码无法保留（重放审计失去依据），
    // 且并发下 `INSERT OR REPLACE` 会**静默吞掉正在校验的那一条**
    const ins = db.prepare(`INSERT INTO auth_codes (email, code_hash, purpose, expires_at) VALUES (?, ?, ?, ?)`);
    ins.run('a@example.com', 'h1', 'login', 1);
    ins.run('a@example.com', 'h2', 'login', 2);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM auth_codes WHERE email = 'a@example.com'`).get() as { c: number }).c).toBe(2);
    db.close();
  });

  it('★ 状态列默认值：`attempts` 为 0、`consumed_at` 可空（未消费 ≠ 已消费）', () => {
    const db = openIsolated(tmp());
    const cols = codeCols(db);
    expect(cols.find((c) => c.name === 'attempts')?.dflt_value).toBe('0');
    expect(cols.find((c) => c.name === 'attempts')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'consumed_at')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'consumed_at')?.dflt_value).toBeNull();
    // 真写一行：不传 attempts 落 0、不传 consumed_at 落 NULL
    db.prepare(`INSERT INTO auth_codes (email, code_hash, purpose, expires_at) VALUES ('a@example.com', 'h', 'login', 1)`).run();
    const row = db.prepare(`SELECT attempts, consumed_at FROM auth_codes`).get() as { attempts: number; consumed_at: number | null };
    expect(row.attempts).toBe(0);
    expect(row.consumed_at).toBeNull();
    db.close();
  });

  it('`email` 不设外键：验证码可以**先于注册**存在（register 态就是给还没有的账号发码）', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO auth_codes (email, code_hash, purpose, expires_at) VALUES ('ghost@example.com', 'h', 'register', 1)`).run();
    expect((db.prepare(`SELECT COUNT(*) AS c FROM auth_codes WHERE email = 'ghost@example.com'`).get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('老库升级：新表与索引自动补回（v27 是**纯建表**型，重放不撞 duplicate）', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    old.exec(`DROP TABLE IF EXISTS auth_codes`);
    // v28 复习范围：本用例只退到 v26（v28 的 ADD COLUMN 不幂等），故 v28 的两列要单独退；
    // 先删索引再删列（SQLite 不留悬空索引）。
    old.exec(`DROP INDEX IF EXISTS idx_term_library_review_enabled`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_enabled`);
    old.exec(`ALTER TABLE term_domain DROP COLUMN review_enabled`);
    revertV29(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 26').run();
    old.close();

    const upgraded = openIsolated(dir);
    expect(codeCols(upgraded).map((c) => c.name)).toContain('code_hash');
    expect(
      upgraded.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_auth_codes_email_purpose'`).get(),
    ).toBeTruthy();
    upgraded.close();
  });
});

describe('storage/db — v28 复习范围迁移（docs/EBBINGHAUS-SPEC.md §9，选择式复习）', () => {
  const termCols = (db: ReturnType<typeof openIsolated>) =>
    db.prepare(`PRAGMA table_info(term_library)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
  const domainCols = (db: ReturnType<typeof openIsolated>) =>
    db.prepare(`PRAGMA table_info(term_domain)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;

  it('新库：term_library.review_enabled **可空**（NULL = 继承领域），term_domain.review_enabled NOT NULL DEFAULT 0', () => {
    const db = openIsolated(tmp());
    const t = termCols(db).find((c) => c.name === 'review_enabled');
    // ★ 可空是这一版的**核心设计**：`NULL` 表示"跟随领域开关"。写成 NOT NULL DEFAULT 0 的话，
    //   "领域已开启"与"新词条默认关闭"就冲突，只能靠写入侧回填 —— 那是第二份范围口径。
    expect(t).toBeDefined();
    expect(t?.notnull).toBe(0);
    expect(t?.dflt_value).toBeNull();

    const d = domainCols(db).find((c) => c.name === 'review_enabled');
    expect(d?.notnull).toBe(1);
    expect(d?.dflt_value).toBe('0'); // 默认全不选（老板 2026-09-18 拍板）
    db.close();
  });

  it('新库：idx_term_library_review_enabled 索引就位', () => {
    const db = openIsolated(tmp());
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_term_library_review_enabled'`).get(),
    ).toBeTruthy();
    db.close();
  });

  it('老库升级：既有领域一律 review_enabled=0（复习池为空，不是"悄悄全开"）', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    old.prepare(`INSERT INTO term_domain (name) VALUES ('math')`).run();
    old.exec(`DROP INDEX IF EXISTS idx_term_library_review_enabled`);
    old.exec(`ALTER TABLE term_library DROP COLUMN review_enabled`);
    old.exec(`ALTER TABLE term_domain DROP COLUMN review_enabled`);
    revertV29(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 27').run();
    old.close();

    const upgraded = openIsolated(dir);
    const rows = upgraded.prepare(`SELECT name, review_enabled FROM term_domain ORDER BY name`).all() as Array<{
      name: string;
      review_enabled: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    // ★ 默认必须落到 0：若给 DEFAULT 1，老用户升级后会**突然被一堆娱乐词条催复习**，
    //   而本功能的前提正是"词条库是 AI 从全部对话里抽的，混着娱乐内容"。
    for (const r of rows) expect(r.review_enabled).toBe(0);
    upgraded.close();
  });

  it('★ 不落 `next_review_*` 之类的派生列：范围只存两个开关，有效范围每次现算', () => {
    const db = openIsolated(tmp());
    const names = [...termCols(db), ...domainCols(db)].map((c) => c.name);
    // 与 v23「不落 next_review_at」同一条理由：范围是派生值（覆盖位 + 领域开关的组合），
    // 落库就得在每次开关变化时洗全表，且新老行口径必然分裂。
    expect(names.some((n) => n.startsWith('next_review'))).toBe(false);
    expect(names).not.toContain('review_in_scope');
    db.close();
  });
});

describe('storage/db — v29 LLM 成本归主迁移（docs/TENANCY-SPEC.md §8.1，M2c）', () => {
  const colsOf = (db: ReturnType<typeof openIsolated>, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  it('新库三处齐备：providers.owner_id / token_usage.user_id / role_bindings 复合主键 + 平台行部分唯一索引', () => {
    const db = openIsolated(tmp());
    expect(colsOf(db, 'providers')).toContain('owner_id');
    expect(colsOf(db, 'token_usage')).toContain('user_id');
    // role_bindings 列序即声明序；`pk > 0` 的两列必须是 (owner_id, role)
    const rb = db.prepare(`PRAGMA table_info(role_bindings)`).all() as Array<{ name: string; pk: number }>;
    expect(rb.map((c) => c.name)).toEqual(['owner_id', 'role', 'provider_id', 'model']);
    expect(rb.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['owner_id', 'role']);
    // ★ 平台行的唯一性靠**部分唯一索引**（复合 PK 在 SQLite 下对 NULL 无效，见下一条用例）
    const idx = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_role_bindings_platform'`)
      .all() as Array<{ sql: string }>;
    expect(idx).toHaveLength(1);
    expect(idx[0]?.sql ?? '').toContain('WHERE owner_id IS NULL');
    db.close();
  });

  it('★ 平台行（owner_id IS NULL）必须唯一：复合主键兜不住，是部分唯一索引在兜', () => {
    const db = openIsolated(tmp());
    const ins = db.prepare(
      `INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (NULL, 'explain', ?, '')`,
    );
    ins.run('p-a');
    // 不补索引的话这里会**成功**（SQLite 的 UNIQUE/PK 一律把 NULL 视作互不相同）——
    // 实测见 `_probe/sqlite-null-pk-probe.mjs`。后果不是理论风险：`seedIfEmpty()` 用
    // `INSERT OR IGNORE` 写平台绑定，没有唯一约束兜底就会每调一次多一行，绑定变成抽签。
    expect(() => ins.run('p-b')).toThrow(/UNIQUE/i);
    const n = (db.prepare(`SELECT COUNT(*) AS c FROM role_bindings WHERE owner_id IS NULL`).get() as { c: number }).c;
    expect(n).toBe(1);
    db.close();
  });

  it('用户行：同人同角色只能一条（复合 PK 生效），★ 不同人同角色必须能共存', () => {
    const db = openIsolated(tmp());
    const ins = db.prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (?, 'explain', ?, '')`);
    ins.run('u1', 'p-a');
    expect(() => ins.run('u1', 'p-b')).toThrow(/PRIMARYKEY|UNIQUE/i);
    ins.run('u2', 'p-c'); // ★ 这正是本批要买到的东西：B 绑自己的模型，不影响 A
    const rows = db
      .prepare(`SELECT owner_id, provider_id FROM role_bindings WHERE role = 'explain' ORDER BY owner_id`)
      .all() as Array<{ owner_id: string; provider_id: string }>;
    expect(rows).toEqual([
      { owner_id: 'u1', provider_id: 'p-a' },
      { owner_id: 'u2', provider_id: 'p-c' },
    ]);
    db.close();
  });

  it('★ 写路径的两个冲突目标都能命中：用户行走 PK，平台行走部分索引（否则运行时 500）', () => {
    const db = openIsolated(tmp());
    // 用户行：ON CONFLICT(owner_id, role) —— 与 `PUT /roles/:role` 的语句同型
    const upsertUser = db.prepare(
      `INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id, role) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`,
    );
    upsertUser.run('u1', 'coach', 'p-a', 'm1');
    upsertUser.run('u1', 'coach', 'p-b', 'm2'); // 第二次必须是更新而不是报错
    // 平台行：ON CONFLICT(role) WHERE owner_id IS NULL —— 冲突目标必须带同样的 WHERE 才认部分索引
    const upsertPlatform = db.prepare(
      `INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (NULL, ?, ?, ?)
        ON CONFLICT(role) WHERE owner_id IS NULL DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`,
    );
    upsertPlatform.run('coach', 'p-x', 'mx');
    upsertPlatform.run('coach', 'p-y', 'my');
    const rows = db
      .prepare(`SELECT owner_id, provider_id, model FROM role_bindings WHERE role = 'coach' ORDER BY owner_id`)
      .all() as Array<{ owner_id: string | null; provider_id: string; model: string }>;
    expect(rows).toEqual([
      { owner_id: null, provider_id: 'p-y', model: 'my' },
      { owner_id: 'u1', provider_id: 'p-b', model: 'm2' },
    ]);
    db.close();
  });

  it('老库升级：既有绑定回填 `NULL`（= 平台通道），★ 不是空串、也不是某个用户', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    // ★ 顺序要紧：先退回旧结构（`revertV29` 会 DROP 并重建 role_bindings），再往**旧表**里塞老行，
    //   否则老行会被 DROP 掉，用例就变成了"空表升级"，测不到回填。
    revertV29(old);
    old.prepare(`INSERT INTO role_bindings (role, provider_id, model) VALUES ('explain', 'openai-default', 'gpt-4o')`).run();
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 28').run();
    old.close();

    const upgraded = openIsolated(dir);
    const row = upgraded
      .prepare(`SELECT owner_id, role, provider_id, model FROM role_bindings WHERE role = 'explain'`)
      .get() as { owner_id: string | null; role: string; provider_id: string; model: string } | undefined;
    expect(row).toBeDefined(); // 数据不丢
    expect(row?.owner_id).toBeNull(); // ★ NULL（平台通道）
    expect(row?.owner_id).not.toBe(''); // ★ 绝不能是空串：那会落进"某个不存在的用户"的空档
    expect(row?.provider_id).toBe('openai-default');
    expect(row?.model).toBe('gpt-4o');
    upgraded.close();
  });
});

describe('storage/db — v30 设置与反馈环归主迁移（docs/TENANCY-SPEC.md §8.2，M2d-1）', () => {
  /** 表的主键列（按声明序），用于断言"复合主键真的含 owner_id" */
  const pkOf = (db: ReturnType<typeof openIsolated>, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

  it('新库四张表都含 owner_id 且它是**主键第一列**（改前是全局单列主键）', () => {
    const db = openIsolated(tmp());
    expect(pkOf(db, 'app_settings')).toEqual(['owner_id', 'key']);
    expect(pkOf(db, 'user_stats')).toEqual(['owner_id', 'key']);
    expect(pkOf(db, 'daily_activity')).toEqual(['owner_id', 'day', 'type']);
    expect(pkOf(db, 'daily_summaries')).toEqual(['owner_id', 'day']);
    db.close();
  });

  it("★ owner_id 是 `NOT NULL DEFAULT ''`：不是可空（与 v29 的 providers 刻意相反，见迁移头注）", () => {
    const db = openIsolated(tmp());
    for (const t of ['app_settings', 'user_stats', 'daily_activity', 'daily_summaries']) {
      const col = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>).find(
        (c) => c.name === 'owner_id',
      );
      expect(col?.notnull, t).toBe(1);
      // DEFAULT '' 的形态在 PRAGMA 里是字符串 `''`（含引号）
      expect(col?.dflt_value, t).toBe("''");
    }
    db.close();
  });

  it('★★ 跨用户撞键回归（本批的核心承诺）：A、B 同名 key / 同日同 type 必须能共存', () => {
    const db = openIsolated(tmp());
    const setA = db.prepare(`INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)`);
    setA.run('u1', 'quiz_mix', 'A');
    setA.run('u2', 'quiz_mix', 'B'); // ★ 改前这里是 PRIMARYKEY 冲突
    const actA = db.prepare(`INSERT INTO daily_activity (owner_id, day, type, count) VALUES (?, ?, ?, ?)`);
    actA.run('u1', '2026-09-18', 'chat_done', 3);
    actA.run('u2', '2026-09-18', 'chat_done', 7); // ★ 改前 `PK(day,type)` 直接撞
    const sumA = db.prepare(`INSERT INTO daily_summaries (owner_id, day, content) VALUES (?, ?, ?)`);
    sumA.run('u1', '2026-09-18', 'A 的总结');
    sumA.run('u2', '2026-09-18', 'B 的总结'); // ★ 改前 `PK(day)`：B 会读到 A 的
    const stA = db.prepare(`INSERT INTO user_stats (owner_id, key, value) VALUES (?, ?, ?)`);
    stA.run('u1', 'xp', '100');
    stA.run('u2', 'xp', '5'); // ★ 改前 A、B 的 XP 是同一个数

    const mixOf = (u: string): string =>
      (db.prepare(`SELECT value FROM app_settings WHERE owner_id = ? AND key = 'quiz_mix'`).get(u) as { value: string }).value;
    expect(mixOf('u1')).toBe('A');
    expect(mixOf('u2')).toBe('B');
    const xpOf = (u: string): string =>
      (db.prepare(`SELECT value FROM user_stats WHERE owner_id = ? AND key = 'xp'`).get(u) as { value: string }).value;
    expect(xpOf('u1')).toBe('100');
    expect(xpOf('u2')).toBe('5');
    db.close();
  });

  it('★ 同一个人同一天同 type 仍然只能一条（复合主键没被「放宽」成不约束）', () => {
    const db = openIsolated(tmp());
    const ins = db.prepare(`INSERT INTO daily_activity (owner_id, day, type, count) VALUES (?, ?, ?, ?)`);
    ins.run('u1', '2026-09-18', 'chat_done', 1);
    expect(() => ins.run('u1', '2026-09-18', 'chat_done', 1)).toThrow(/PRIMARYKEY|UNIQUE/i);
    db.close();
  });

  it("★ 单值读**不能**豁免过滤：库里同时有 `''` 与 `'u1'` 两行时，`.get()` 必须只取自己那条", () => {
    const db = openIsolated(tmp());
    const ins = db.prepare(`INSERT INTO user_stats (owner_id, key, value) VALUES (?, ?, ?)`);
    ins.run('', 'xp', '999'); // 无主行（本地单人模式的历史数据）
    ins.run('u1', 'xp', '12');
    // 这是"读侧用 ownerForWrite 而不是 ownerFilter"的锁：若读侧写成不加条件，
    // 下面这条会返回**任意一行**（SQLite 通常给 rowid 最小的那条 = 无主行 999）⇒ 静默串台。
    const mine = db.prepare(`SELECT value FROM user_stats WHERE owner_id = ? AND key = 'xp'`).get('u1') as
      | { value: string }
      | undefined;
    expect(mine?.value).toBe('12');
    // ★ 反向也要成立：登录用户**查不到**无主行（无主 ≠ 谁都能看见）
    const orphan = db.prepare(`SELECT value FROM user_stats WHERE owner_id = ? AND key = 'xp'`).get('u2') as
      | { value: string }
      | undefined;
    expect(orphan).toBeUndefined();
    db.close();
  });

  it("老库升级：四张表既有数据全部回填 `''`（无主），★ 不是 NULL、也不是判给某个用户", () => {
    const dir = tmp();
    const old = openIsolated(dir);
    // ★ 顺序要紧：先退回旧结构（revertV30 会 DROP 并重建），再往**旧表**里塞老行，
    //   否则老行会被 DROP 掉，用例就变成了"空表升级"，测不到回填。
    revertV30(old);
    old.prepare(`INSERT INTO app_settings (key, value) VALUES ('quiz_mix', '{"single":4}')`).run();
    old.prepare(`INSERT INTO daily_activity (day, type, count) VALUES ('2026-09-18', 'chat_done', 9)`).run();
    old.prepare(`INSERT INTO daily_summaries (day, content) VALUES ('2026-09-18', '老总结')`).run();
    old.prepare(`INSERT INTO user_stats (key, value) VALUES ('xp', '250')`).run();
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 29').run();
    old.close();

    const up = openIsolated(dir);
    const s = up.prepare(`SELECT owner_id, value FROM app_settings WHERE key = 'quiz_mix'`).get() as {
      owner_id: string;
      value: string;
    };
    expect(s.owner_id).toBe(''); // ★ 空串（无主），不是 NULL
    expect(s.value).toBe('{"single":4}'); // 数据不丢
    expect(
      (up.prepare(`SELECT owner_id FROM daily_activity WHERE day = '2026-09-18'`).get() as { owner_id: string }).owner_id,
    ).toBe('');
    expect(
      (up.prepare(`SELECT owner_id FROM daily_summaries WHERE day = '2026-09-18'`).get() as { owner_id: string }).owner_id,
    ).toBe('');
    expect((up.prepare(`SELECT owner_id FROM user_stats WHERE key = 'xp'`).get() as { owner_id: string }).owner_id).toBe('');
    // ★ 而登录用户读不到它们（无主行只对未登录模式可见）
    expect(up.prepare(`SELECT 1 FROM user_stats WHERE owner_id = ? AND key = 'xp'`).get('u1')).toBeUndefined();
    up.close();
  });

  it('回放迁移链不撞 duplicate：退到 v29 后重开，四张表都按新形状建回', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    revertV30(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 29').run();
    old.close();
    const up = openIsolated(dir);
    expect(pkOf(up, 'app_settings')).toEqual(['owner_id', 'key']);
    expect(pkOf(up, 'daily_summaries')).toEqual(['owner_id', 'day']);
    expect(up.prepare(`SELECT MAX(version) AS v FROM schema_version`).get()).toEqual({ v: HEAD_VERSION });
    up.close();
  });
});

/**
 * v31（M2d-2）：`term_library` / `term_domain` / `term_mention_log` 归主。
 *
 * ★ `revertV31` 的旧结构**逐字取自迁移源文件**，不要凭印象写：
 *   · `term_library` 的 17 列是 **v1 建表（11 列）+ 6 次 ALTER** 累积的结果
 *     （`aliases` / `evo_level` / `best_level` / `evo_updated_at` / `review_stage` /
 *     `last_reviewed_at` / `review_enabled`），不是最初那一版；
 *   · 旧约束是 `UNIQUE(term, domain)`（**没有** owner）；
 *   · `term_mention_log` 的 `owner_id` 那时**可空**（`TEXT`，无 NOT NULL 无 DEFAULT）。
 *   漏一列会让后续迁移的 `UPDATE` 报 `no such column`；漏一个约束会让"回放后重开"变成空转。
 */
function revertV31(db: ReturnType<typeof openIsolated>): void {
  db.exec(`DROP TABLE IF EXISTS term_library`);
  db.exec(`CREATE TABLE term_library (
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
    aliases TEXT NOT NULL DEFAULT '[]',
    evo_level INTEGER NOT NULL DEFAULT 0,
    best_level INTEGER NOT NULL DEFAULT 0,
    evo_updated_at TEXT,
    review_stage INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at TEXT,
    review_enabled INTEGER,
    UNIQUE(term, domain)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_term_domain ON term_library(domain)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_term_library_last_reviewed ON term_library(last_reviewed_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_term_library_review_enabled ON term_library(review_enabled)`);
  db.exec(`DROP TABLE IF EXISTS term_domain`);
  db.exec(`CREATE TABLE term_domain (
    name TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    review_enabled INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`DROP TABLE IF EXISTS term_mention_log`);
  db.exec(`CREATE TABLE term_mention_log (
    id TEXT PRIMARY KEY,
    term_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    owner_id TEXT,
    mentioned_at TEXT NOT NULL DEFAULT (datetime('now')),
    mentioned_day TEXT NOT NULL DEFAULT (date('now'))
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_term_mention_term ON term_mention_log(term_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_term_mention_day ON term_mention_log(mentioned_day)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_term_mention_lookup ON term_mention_log(owner_id, domain, mentioned_day)`);
}

describe('storage/db — v31 词条库/领域归主迁移（docs/TENANCY-SPEC.md §8.2，M2d-2）', () => {
  /** 列名（按声明序） */
  const colsOf = (db: ReturnType<typeof openIsolated>, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  /** 主键列（按声明序） */
  const pkOf = (db: ReturnType<typeof openIsolated>, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
  /** 唯一索引的列组合（含 SQLite 为 UNIQUE/PK 建的 `sqlite_autoindex_*`） */
  const uniqueColsOf = (db: ReturnType<typeof openIsolated>, table: string): string[][] =>
    (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>)
      .filter((i) => i.unique === 1)
      .map((i) =>
        (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map((c) => c.name),
      );

  it('新库：三张表都含 owner_id；`term_domain` 的主键换成 `(owner_id, name)`', () => {
    const db = openIsolated(tmp());
    for (const t of ['term_library', 'term_domain', 'term_mention_log']) {
      expect(colsOf(db, t), t).toContain('owner_id');
    }
    // ★ term_domain 是"名字单列 PK"那一类，必须整片换成复合主键
    expect(pkOf(db, 'term_domain')).toEqual(['owner_id', 'name']);
    // ★ 而 term_library 的**主键仍是 `id` 单列**（uuid 全局唯一；`term_review_log.term_id` /
    //   `knowledge_node.ref_id` 都按 id 引用它，改复合主键会让这些"只知道 id"的引用丢索引前缀）
    expect(pkOf(db, 'term_library')).toEqual(['id']);
    expect(pkOf(db, 'term_mention_log')).toEqual(['id']);
    db.close();
  });

  it('★★ 唯一键换成 `(owner_id, term, domain)`——改前是 `(term, domain)`（本批的核心承诺）', () => {
    const db = openIsolated(tmp());
    expect(uniqueColsOf(db, 'term_library')).toContainEqual(['owner_id', 'term', 'domain']);
    expect(uniqueColsOf(db, 'term_library')).not.toContainEqual(['term', 'domain']);
    db.close();
  });

  it("★ owner_id 是 `NOT NULL DEFAULT ''`：不是可空（与 v29 providers 的 NULL 刻意相反）", () => {
    const db = openIsolated(tmp());
    for (const t of ['term_library', 'term_domain', 'term_mention_log']) {
      const col = (
        db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>
      ).find((c) => c.name === 'owner_id');
      expect(col?.notnull, t).toBe(1);
      expect(col?.dflt_value, t).toBe("''");
    }
    db.close();
  });

  it('★ 列完整性：`term_library` 仍是 18 列（17 老列 + owner_id），漏列 = 静默丢数据', () => {
    const db = openIsolated(tmp());
    expect(colsOf(db, 'term_library')).toEqual([
      'owner_id',
      'id',
      'term',
      'definition',
      'domain',
      'source_session_id',
      'importance',
      'usage_count',
      'last_used_at',
      'created_at',
      'updated_at',
      'aliases',
      'evo_level',
      'best_level',
      'evo_updated_at',
      'review_stage',
      'last_reviewed_at',
      'review_enabled',
    ]);
    db.close();
  });

  it('★★ 跨用户撞键回归：A、B 同名领域 / 同 (term, domain) / 同名流水必须能共存', () => {
    const db = openIsolated(tmp());
    const dom = db.prepare(`INSERT INTO term_domain (owner_id, name) VALUES (?, ?)`);
    dom.run('u1', '物理');
    dom.run('u2', '物理'); // ★ 改前 `name` 单列 PK：第二个人直接 SQLITE_CONSTRAINT_PRIMARYKEY
    const term = db.prepare(
      `INSERT INTO term_library (owner_id, id, term, definition, domain) VALUES (?, ?, ?, ?, ?)`,
    );
    term.run('u1', 't1', '牛顿第二定律', 'F=ma', '物理');
    term.run('u2', 't2', '牛顿第二定律', 'F=ma', '物理'); // ★ 改前 UNIQUE(term,domain) 撞键
    const log = db.prepare(
      `INSERT INTO term_mention_log (owner_id, id, term_id, domain) VALUES (?, ?, ?, ?)`,
    );
    log.run('u1', 'm1', 't1', '物理');
    log.run('u2', 'm2', 't2', '物理');

    const mine = (u: string): string =>
      (db.prepare(`SELECT definition FROM term_library WHERE owner_id = ? AND term = '牛顿第二定律'`).get(u) as {
        definition: string;
      }).definition;
    expect(mine('u1')).toBe('F=ma');
    expect(mine('u2')).toBe('F=ma');
    expect((db.prepare(`SELECT COUNT(*) AS c FROM term_domain WHERE name = '物理'`).get() as { c: number }).c).toBe(2);
    db.close();
  });

  it('★ 同一个人重复 `(term, domain)` 仍被拦（唯一键没被"放宽"成不约束）', () => {
    const db = openIsolated(tmp());
    const ins = db.prepare(
      `INSERT INTO term_library (owner_id, id, term, definition, domain) VALUES (?, ?, ?, ?, ?)`,
    );
    ins.run('u1', 't1', '闭包', 'x', 'cs');
    expect(() => ins.run('u1', 't2', '闭包', 'y', 'cs')).toThrow(/UNIQUE/i);
    // 换个人就行（这正是本批要的那个自由度）
    expect(() => ins.run('u2', 't3', '闭包', 'y', 'cs')).not.toThrow();
    db.close();
  });

  it('★ 单值读不能豁免过滤：库里同时有无主行与 `u1` 行时，各读各的（无主 ≠ 谁都能看见）', () => {
    const db = openIsolated(tmp());
    const ins = db.prepare(`INSERT INTO term_library (owner_id, id, term, definition, domain) VALUES (?, ?, ?, ?, ?)`);
    ins.run('', 'o1', '孤儿词条', '本地单人模式的历史', 'general');
    ins.run('u1', 'a1', '我的词条', 'u1 的', 'general');
    const one = (u: string) =>
      db.prepare(`SELECT definition FROM term_library WHERE owner_id = ? AND term = '孤儿词条'`).get(u) as
        | { definition: string }
        | undefined;
    expect(one('u1')).toBeUndefined(); // ★ 登录用户看不到无主行
    expect(one('')).toBeTruthy(); // 无主行只对无主模式可见
    db.close();
  });

  it("★ `term_mention_log.owner_id` 不再是 NULL：老行的 NULL 回填成 `''`（口径对齐）", () => {
    const dir = tmp();
    const old = openIsolated(dir);
    revertV31(old);
    old.prepare(`INSERT INTO term_mention_log (id, term_id, domain, owner_id) VALUES ('m1', 't1', 'js', NULL)`).run();
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare(`DELETE FROM schema_version WHERE version > 30`).run();
    old.close();

    const up = openIsolated(dir);
    const row = up.prepare(`SELECT owner_id FROM term_mention_log WHERE id = 'm1'`).get() as { owner_id: string };
    expect(row.owner_id).toBe(''); // ★ 空串，不是 NULL
    up.close();
  });

  it("老库升级：三张表既有数据全部回填 `''`（无主），且列值一个不丢", () => {
    const dir = tmp();
    const old = openIsolated(dir);
    revertV31(old);
    old
      .prepare(
        `INSERT INTO term_library (id, term, definition, domain, importance, usage_count, aliases, evo_level)
         VALUES ('t1', '闭包', '函数与其词法环境', 'cs', 0.9, 7, '["closure"]', 3)`,
      )
      .run();
    old.prepare(`INSERT INTO term_domain (name, note, review_enabled) VALUES ('cs', '计算机', 1)`).run();
    old.prepare(`INSERT INTO term_mention_log (id, term_id, domain) VALUES ('m1', 't1', 'cs')`).run();
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare(`DELETE FROM schema_version WHERE version > 30`).run();
    old.close();

    const up = openIsolated(dir);
    const t = up
      .prepare(`SELECT owner_id, definition, importance, usage_count, aliases, evo_level FROM term_library`)
      .get() as {
      owner_id: string;
      definition: string;
      importance: number;
      usage_count: number;
      aliases: string;
      evo_level: number;
    };
    expect(t.owner_id).toBe(''); // ★ 无主，不是判给某个用户
    expect(t.definition).toBe('函数与其词法环境');
    expect(t.importance).toBe(0.9);
    expect(t.usage_count).toBe(7);
    expect(t.aliases).toBe('["closure"]'); // ★ ALTER 加进来的列也不能丢
    expect(t.evo_level).toBe(3);
    expect((up.prepare(`SELECT owner_id FROM term_domain WHERE name = 'cs'`).get() as { owner_id: string }).owner_id).toBe(
      '',
    );
    expect(
      (up.prepare(`SELECT owner_id FROM term_mention_log WHERE id = 'm1'`).get() as { owner_id: string }).owner_id,
    ).toBe('');
    // ★ 而登录用户读不到它们（无主行只对无主模式可见）
    expect(up.prepare(`SELECT 1 FROM term_library WHERE owner_id = 'u1' AND term = '闭包'`).get()).toBeUndefined();
    up.close();
  });

  it('回放迁移链不撞 duplicate：退到 v30 后重开，三张表都按新形状建回', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    revertV31(old);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare(`DELETE FROM schema_version WHERE version > 30`).run();
    old.close();
    const up = openIsolated(dir);
    expect(pkOf(up, 'term_domain')).toEqual(['owner_id', 'name']);
    expect(uniqueColsOf(up, 'term_library')).toContainEqual(['owner_id', 'term', 'domain']);
    // ★ 索引也要在（新表是 DROP+RENAME 出来的，忘了重建索引不会报错，只会静默全表扫）
    const idx = (up.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    for (const n of ['idx_term_domain', 'idx_term_library_review_enabled', 'idx_term_mention_lookup']) {
      expect(idx, n).toContain(n);
    }
    up.close();
  });
});

/**
 * v32（P1 计时呈现线，契约 TOOL-ECOSYSTEM-SPEC §4.7）：messages 两处纯加列。
 * `thinking_ms` 挂 assistant 行（本轮思考耗时），`duration_ms` 挂 tool 行（单工具执行耗时）。
 * ★ 本仓纪律：每加一列迁移，所有「退版本重放」用例都要跟着多退一列——revertV32 已进全部先例，
 *   这里锁的是列本身的存在与「NULL≠0」口径（耗时缺失落 NULL，显示侧退「无时长」而不是「0 秒」）。
 */
describe('storage/db — v32 计时落库迁移（thinking_ms / duration_ms）', () => {
  const msgCols = (db: ReturnType<typeof openIsolated>): string[] =>
    (db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map((c) => c.name);

  it('新库的 messages 含 thinking_ms / duration_ms 两列', () => {
    const db = openIsolated(tmp());
    expect(msgCols(db)).toEqual(expect.arrayContaining(['thinking_ms', 'duration_ms']));
    db.close();
  });

  it('缺省落 NULL、显式 0 存 0：「没测到」与「0 毫秒」在库里必须可分辨', () => {
    const db = openIsolated(tmp());
    db.prepare(`INSERT INTO sessions (id) VALUES ('s1')`).run();
    db.prepare(`INSERT INTO messages (id, session_id, role, content) VALUES ('m1', 's1', 'assistant', 'x')`).run();
    db.prepare(`INSERT INTO messages (id, session_id, role, content, thinking_ms, duration_ms) VALUES ('m2', 's1', 'tool', 'y', 0, 0)`).run();
    const m1 = db.prepare(`SELECT thinking_ms, duration_ms FROM messages WHERE id = 'm1'`).get() as {
      thinking_ms: number | null;
      duration_ms: number | null;
    };
    expect(m1).toEqual({ thinking_ms: null, duration_ms: null });
    const m2 = db.prepare(`SELECT thinking_ms, duration_ms FROM messages WHERE id = 'm2'`).get() as {
      thinking_ms: number | null;
      duration_ms: number | null;
    };
    expect(m2).toEqual({ thinking_ms: 0, duration_ms: 0 });
    db.close();
  });

  it('退到 v31 重开不撞 duplicate column：两列自动补回（ADD COLUMN 不幂等的第六次先例）', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    revertV32(old);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 31').run();
    expect(msgCols(old)).not.toContain('thinking_ms');
    old.close();

    const up = openIsolated(dir);
    expect(msgCols(up)).toEqual(expect.arrayContaining(['thinking_ms', 'duration_ms']));
    up.close();
  });
});

describe('storage/db — v33 其余表归主迁移（M2d-3：quiz_*/flow_*/knowledge_* 八处加列）', () => {
  const colsOf = (db: ReturnType<typeof openIsolated>, table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  it("新库八张表都含 owner_id 且 NOT NULL DEFAULT ''（无主 = 谁都看不见，与 v29 平台可见刻意相反）", () => {
    const db = openIsolated(tmp());
    for (const t of ['quiz_bank', 'quiz_stats', 'quiz_notes', 'flow_def', 'flow_run', 'flow_run_step', 'knowledge_node', 'knowledge_edge']) {
      expect(colsOf(db, t)).toContain('owner_id');
      const col = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>).find(
        (c) => c.name === 'owner_id',
      );
      expect(col?.notnull).toBe(1);
      expect(col?.dflt_value).toBe("''");
    }
    db.close();
  });

  it("★ 老行回填 ''（无主），不判给任何用户；写入侧不带 owner 也落 ''（DEFAULT 生效）", () => {
    const dir = tmp();
    const db = openIsolated(dir);
    db.prepare(`INSERT INTO quiz_bank (id, title, source, data) VALUES ('q1', '老题库', 'ai', '{}')`).run();
    const row = db.prepare(`SELECT owner_id FROM quiz_bank WHERE id = 'q1'`).get() as { owner_id: string };
    expect(row.owner_id).toBe('');
    db.close();
  });

  it('退到 v32 重放不撞 duplicate column：八列自动补回（ADD COLUMN 不幂等的第七次先例）', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    revertV33(old);
    revertV36(old);
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 32').run();
    expect(colsOf(old, 'quiz_bank')).not.toContain('owner_id');
    old.close();

    const up = openIsolated(dir);
    expect(colsOf(up, 'quiz_bank')).toContain('owner_id');
    expect(colsOf(up, 'knowledge_node')).toContain('owner_id');
    up.close();
  });
});

/**
 * v37（全站全文搜索，契约 `docs/FTS-SPEC.md` §3.2）：一张 fts5 虚表 `search_index`。
 *
 * ★ **纯建表型迁移（无加列）⇒ 回放本身安全**，故没有 `revertV37` 进"每个退版本用例都要调"
 *   那份清单（同 v25/v26/v27 的处置，见 `migrations-list-v22.ts` 文件头）。
 *   但本用例仍**显式 DROP 主表**再重放：留着它就等于"老库凭空带着搜索索引"，
 *   那样测不出「v37 真的把表建出来了」这件事本身。
 * ★ **fts5 虚表会连带建五张影子表**（`search_index_data` / `_idx` / `_content` /
 *   `_docsize` / `_config`）：`DROP TABLE search_index` 由 fts5 的 xDestroy 一并清掉，
 *   故只需 DROP 主表。★ 若日后有人把它改成 `external content` / `contentless` 表，
 *   影子表集合会变，本用例的清单要跟着改。
 * ★ 第二条用例锁的是「不是只建了个空壳」：fts5 的 MATCH 与 bm25() 都要真能跑。
 *   只断言"表存在"会漏掉一类事故——DDL 语法过但列定义写错（例如 tokens 标了 UNINDEXED），
 *   那时表在、查不了，而单看 `sqlite_master` 完全正常。
 */
describe('storage/db — v37 全站搜索索引（fts5 虚表）', () => {
  const tablesOf = (db: ReturnType<typeof openIsolated>): string[] =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );

  it('新库有 search_index 虚表，且五张影子表齐全（fts5 的建表契约）', () => {
    const db = openIsolated(tmp());
    const t = tablesOf(db);
    expect(t).toContain('search_index');
    for (const shadow of [
      'search_index_data',
      'search_index_idx',
      'search_index_content',
      'search_index_docsize',
      'search_index_config',
    ]) {
      expect(t, shadow).toContain(shadow);
    }
    db.close();
  });

  it('★ MATCH 与 bm25() 真能跑（不是建了个查不了的空壳）', () => {
    const db = openIsolated(tmp());
    db.prepare(
      `INSERT INTO search_index (tokens, kind, ref_id, owner, title, snippet, updated_at)
       VALUES (?, 'term', 'r1', '', '标题', '摘要', '')`,
    ).run('牛顿 顿第 第二 二定 定律');
    const hit = db
      .prepare(`SELECT ref_id, bm25(search_index) AS score FROM search_index WHERE search_index MATCH ?`)
      .get('"牛顿"') as { ref_id: string; score: number } | undefined;
    expect(hit?.ref_id).toBe('r1');
    expect(typeof hit?.score).toBe('number');
    db.close();
  });

  it('退到 v36 重放：表按新形状建回，不撞 duplicate', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    old.exec('DROP TABLE IF EXISTS search_index');
    revertV38(old);
    revertV40(old);
    old.prepare('DELETE FROM schema_version WHERE version > 36').run();
    expect(tablesOf(old)).not.toContain('search_index');
    old.close();

    const up = openIsolated(dir);
    expect(tablesOf(up)).toContain('search_index');
    up.close();
  });
});

/**
 * v39（2026-09-21，老板拍板「默认零配置 + 每 5 小时 250 次」）：平台通道的**调用次数**用量表。
 *
 * ★ 为什么必须落库而不是进程内 `Map`：次数配额是**滚动窗口内的累计量**，而本仓部署很频繁
 *   （09-20 一天重启 4 次）——放进程内，每次部署都把用户的额度洗回 250，配额形同虚设。
 *   行为断言在 `llm/platform-quota.test.ts`，本组只钉**表结构**（它才是迁移的责任）。
 */
describe('storage/db — v39 平台用量表（platform_usage）', () => {
  const tablesOf = (db: ReturnType<typeof openIsolated>): string[] =>
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );

  it('新库有 platform_usage 表与 (owner_id, ts) 索引（窗口查询全靠它）', () => {
    const db = openIsolated(tmp());
    expect(tablesOf(db)).toContain('platform_usage');
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='platform_usage'`)
      .all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_platform_usage_owner_ts');
    db.close();
  });

  it('★ owner_id 是 NOT NULL：计数必须落在**某个具体的人**身上', () => {
    const db = openIsolated(tmp());
    // 平台 provider 的 owner 恒为 NULL；若这张表允许 NULL，就会退化成"所有免费用户
    // 共享同一份额度"（`upstream-gate.ts` 内层分桶那个坑的姊妹版）⇒ 由约束挡住。
    expect(() => db.prepare('INSERT INTO platform_usage (owner_id, ts) VALUES (NULL, 1)').run()).toThrow();
    db.close();
  });

  it('ts 存 unix 毫秒整数：窗口比较不受时区影响（`coach_messages` 那个 UTC 文本坑）', () => {
    const db = openIsolated(tmp());
    db.prepare('INSERT INTO platform_usage (owner_id, ts) VALUES (?, ?)').run('u1', 1_700_000_000_000);
    const row = db.prepare('SELECT ts FROM platform_usage WHERE owner_id = ?').get('u1') as { ts: number };
    expect(row.ts).toBe(1_700_000_000_000);
    expect(typeof row.ts).toBe('number');
    db.close();
  });

  it('★ 退到 v38 重放：表真的被 v39 建回来（先 DROP 才有意义）', () => {
    const dir = tmp();
    const old = openIsolated(dir);
    revertV39(old);
    revertV40(old); // ★ v40 > 38 ⇒ 同样要退（v39 是幂等建表可免，v40 是加列**不可免**）
    old.prepare('DELETE FROM schema_version WHERE version > 38').run();
    expect(tablesOf(old)).not.toContain('platform_usage'); // ★ 退干净了，下面的"建回"才成立
    old.close();

    const up = openIsolated(dir);
    expect(tablesOf(up)).toContain('platform_usage');
    expect(
      (up.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v,
    ).toBe(HEAD_VERSION);
    up.close();
  });
});
