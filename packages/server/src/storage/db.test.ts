import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated } from './db.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-db-test-'));
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
