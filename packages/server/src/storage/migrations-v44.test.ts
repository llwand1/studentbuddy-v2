/**
 * storage/migrations-v44 — 本仓**第一条删除型迁移**的结构锁（学习流/知识图七张表下线，2026-09-25）。
 *
 * 钉的是三件事，每件都对应一族只有删除型迁移才会有的事故：
 *  ① **删干净**（七张表与其九条索引都不留壳，孤儿索引会让将来同名建表撞 `already exists`）；
 *  ② **只删这七张**（DROP 语句多写一行就是生产事故，而它不会在任何功能测试里响）；
 *  ③ **老库升上来也一样干净**（新库是"建了又删"，老库是"带着真数据被删"——两条路径都要走）。
 *
 * ★ 为什么不追加进 `db.test.ts`：那里 1300+ 行的「退版本重放」用例正被这条迁移**直接影响**
 *   （`revertV33()` 不能再对已删表做 ALTER），同文件同批改容易与同伴的 v43 那片撞车。
 *   本文件只钉迁移该负责的东西＝**库面形状**；功能面（前端已无入口、路由已摘）不在这里，
 *   那些红会由 `seo/`、`routes/` 与 gates 各自逮。
 *
 * ⚠️ 两条**源码层**断言（用例 7、9）不是运行锁：它们读的是 `MIGRATIONS` 这个数组本身。
 *   这样写是因为要钉的对象恰好**不该被执行**——往迁移里加 `VACUUM` 会让每版一事务的执行器
 *   当场抛，而"回改 v18 把它删掉"在运行时看不出任何区别（新旧库最后都没这七张表）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openIsolated } from './db.js';
import { MIGRATIONS } from './migrations-list.js';

/** 最高版本号用算的、不写死（同 `db.test.ts` 的取向：写死＝多抄一份会漂移的快照） */
const HEAD_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/** v44 该删的那七张（`flow_*` 五张 + `knowledge_*` 两张，契约沿革见 `docs/STUDY-FLOW-SPEC.md` 墓碑） */
const DROPPED = ['flow_def', 'flow_step', 'flow_edge', 'flow_run', 'flow_run_step', 'knowledge_node', 'knowledge_edge'];

const v44 = MIGRATIONS.find((m) => m.version === 44);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-v44-test-'));
}

const tablesOf = (db: Database.Database): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name);

const indexNamesOf = (db: Database.Database): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>).map((r) => r.name);

/**
 * 造一个「停在 v43、且表里有真数据」的老库。
 *
 * ★ 建表用 **v18 自己的语句**而不是手抄一份 DDL：那样钉的是"链上历史那一项仍然有效"，
 *   而手抄的 DDL 会在 v18 被改动时悄悄与真实链分叉（本仓 §0.11 那类"第二份事实源"）。
 * ⚠️ 建回来的是 **v18 的形状**（无 `owner_id` 列，那是 v31/v33 才加的）——本用例只关心
 *   "有表有行"，列形状与 v44 无关，故刻意不补，别以为漏了。
 */
function makeOldDb(dir: string): void {
  const db = openIsolated(dir);
  const v18 = MIGRATIONS.find((m) => m.version === 18);
  if (!v18) throw new Error('v18 不在链上：学习流的建表项被回改了？');
  for (const stmt of v18.statements) db.exec(stmt);
  db.prepare(`INSERT INTO flow_def (id, name) VALUES ('fd-1', '老用户存的流')`).run();
  db.prepare(`INSERT INTO knowledge_node (id, kind) VALUES ('kn-1', 'term')`).run();
  db.prepare(`DELETE FROM schema_version WHERE version > 43`).run();
  expect(tablesOf(db)).toContain('flow_def');
  db.close();
}

describe('storage/db — v44 学习流/知识图七张表下线（第一条删除型迁移）', () => {
  it('① 新库（跑完整条链）里七张表一张都不在', () => {
    const db = openIsolated(tmp());
    const tables = tablesOf(db);
    for (const t of DROPPED) expect(tables).not.toContain(t);
    db.close();
  });

  it('② ★ 只删这七张：相邻功能的表一张都不能少（DROP 多写一行不会在任何功能测试里响）', () => {
    const db = openIsolated(tmp());
    const tables = tablesOf(db);
    for (const t of ['pk_invites', 'ask_choices', 'coach_messages', 'term_library', 'quiz_bank', 'quiz_notes', 'evolution_event', 'sessions', 'messages', 'users']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('③ 不留孤儿索引：v18 建的那九条 `idx_flow_*`/`idx_knowledge_*` 随表一起消失', () => {
    const db = openIsolated(tmp());
    const idx = indexNamesOf(db);
    for (const name of [
      'idx_flow_step_def',
      'idx_flow_edge_def',
      'idx_flow_run_session',
      'idx_flow_run_status',
      'idx_flow_run_step_run',
      'idx_knowledge_node_kind',
      'idx_knowledge_node_source',
      'idx_knowledge_edge_from',
      'idx_knowledge_edge_to',
    ]) {
      expect(idx).not.toContain(name);
    }
    // ★ 通用形状：sqlite_master 里不许存在"指向不存在的表"的索引（DROP 手写漏表时会落在这里）
    const orphan = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name NOT IN (SELECT name FROM sqlite_master WHERE type='table')`)
      .all() as Array<{ name: string }>;
    expect(orphan.map((r) => r.name)).toEqual([]);
    db.close();
  });

  it('④ ★ 老库带着真数据升上来：表与行一起没，读它抛 `no such table`（老板判决＝不留备份、不归档）', () => {
    const dir = tmp();
    makeOldDb(dir);
    const up = openIsolated(dir);
    expect(tablesOf(up)).not.toContain('flow_def');
    expect(tablesOf(up)).not.toContain('knowledge_node');
    expect(() => up.prepare(`SELECT COUNT(*) FROM flow_def`).get()).toThrow(/no such table/);
    up.close();
  });

  it('⑤ 二次执行不报错（`IF EXISTS` 不是习惯性多写：退到 v43 重放就是这一条路径）', () => {
    const db = openIsolated(tmp());
    expect(v44).toBeDefined();
    expect(() => {
      for (const stmt of v44?.statements ?? []) db.exec(stmt);
    }).not.toThrow();
    expect(() => {
      for (const stmt of v44?.statements ?? []) db.exec(stmt);
    }).not.toThrow();
    db.close();
  });

  it('⑥ v44 在链尾且全链严格升序（挂错位置＝低号被静默跳过那一族，同 v43 片头的拦路牌）', () => {
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBe(44);
    const versions = MIGRATIONS.map((m) => m.version);
    for (let i = 1; i < versions.length; i += 1) {
      expect((versions[i] as number) > (versions[i - 1] as number)).toBe(true);
    }
  });

  it('⑦ ★ 源码锁：链上历史未被回改——v18 仍在原地建这七张表（删除只靠追加新版本）', () => {
    const v18 = MIGRATIONS.find((m) => m.version === 18);
    const joined = (v18?.statements ?? []).join('\n');
    for (const t of DROPPED) expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    // ★ 反向半句：v44 的语句里**只有** DROP 这七张，不含任何 CREATE/ALTER
    const v44Joined = (v44?.statements ?? []).join('\n');
    expect(v44Joined).not.toMatch(/CREATE|ALTER|DELETE FROM/);
  });

  it('⑧ 新建库停在 v44（`MAX(schema_version.version)` 用算的最高号，不写死）', () => {
    const db = openIsolated(tmp());
    const row = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number };
    expect(row.v).toBe(HEAD_VERSION);
    expect(db.prepare(`SELECT version FROM schema_version WHERE version = 44`).get()).toEqual({ version: 44 });
    db.close();
  });

  it('⑨ ★ 源码锁：v44 里不许有 `VACUUM`（执行器每版一事务，VACUUM 在事务里必炸）', () => {
    const joined = (v44?.statements ?? []).join('\n');
    expect(joined).not.toMatch(/VACUUM/i);
    expect(joined).toMatch(/DROP TABLE IF EXISTS knowledge_node/);
  });
});
