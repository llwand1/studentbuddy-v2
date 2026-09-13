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

describe('storage/db — v8 认知进化迁移（COGNITIVE-EVOLUTION-SPEC §5，v1.1 落码）', () => {
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

  it('term_library 进化列默认值：evo_level=0 / best_level=0 / evo_updated_at NULL', () => {
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
