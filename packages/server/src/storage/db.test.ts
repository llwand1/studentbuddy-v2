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
