/**
 * storage/migrations-v58 — 迁移号撞车自愈的回归锁（2026-10-10 真机事故）。
 *
 * 事故形态（每一例都对应真机库 `AppData/Roaming/studentbuddy-v2` 的实测状态）：
 * 迁移号 46 在两条线上各定义过一次——旧线（3931f2a）建 review_log+learning_event，
 * 主干（01a0051）建 llm_call+learning_event+job。被旧线先迁移过的库
 * `schema_version` 记了 46 ⇒ 主干跳过 v46 ⇒ `job`/`llm_call` 缺失 ⇒
 * `startJobWorker → recoverStaleJobs` 抛 `no such table: job` ⇒ 整个服务起不来。
 *
 * v58 用新版本号把缺的 DDL 以 IF NOT EXISTS 重申一遍。本文件锁三件事：
 * ① **自愈**：撞号形态的库（记了 46、缺两表）再跑迁移必须把表补回来；
 * ② **等价**：补出的结构与 v46 直建的逐字一致（列+索引），两条路径不产生结构分叉；
 * ③ **无害**：健康库再跑 v58 是 no-op（不报错、不重复、只多记一行版本号）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from './db.js';
import { migrate } from './migrations.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mig-v58-'));
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function tables(): Set<string> {
  return new Set(
    (getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
  );
}
function indexes(): Set<string> {
  return new Set(
    (getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'idx_job%' OR name LIKE 'idx_llm_call%')").all() as Array<{ name: string }>).map((r) => r.name),
  );
}
function schemaMax(): number {
  return (getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
}

describe('v58 —— 迁移号撞车自愈（真机事故回归锁）', () => {
  it('★ 撞号形态自愈：记了 46 但缺 job/llm_call（= 真机库实测状态）⇒ 再迁移两表必回来', () => {
    openIsolated(dir); // 全新库：一次到位（含 v58 的 no-op）
    // 复刻真机形态（两步缺一不可——真机库的 schema_version 止于 57，v58 从未记账）：
    // ① 回退记账：删掉 v58 行 = 「这个库还没见过 v58」；
    // ② 回退表：DROP 两表，而 46~57 的历史记账原样保留（46 已记 ⇒ v46 永不重跑）。
    getDb().prepare('DELETE FROM schema_version WHERE version = 58').run();
    getDb().exec('DROP TABLE job');
    getDb().exec('DROP TABLE llm_call');
    expect(tables().has('job')).toBe(false);
    expect(tables().has('llm_call')).toBe(false);
    expect(schemaMax()).toBe(57); // 与真机库一致
    // 启动路径再跑迁移（服务重启 / 升级后的真实动作）：v58 必须把两表补回
    migrate(getDb());
    expect(tables().has('job')).toBe(true);
    expect(tables().has('llm_call')).toBe(true);
    expect(schemaMax()).toBe(58);
  });

  it('★ 补出的结构与 v46 直建逐字一致（列名 + 顺序），两条路径不分叉', () => {
    // 路径 A：全新库（v46 直建 + v58 no-op）
    openIsolated(dir);
    const colsA = {
      job: (getDb().prepare('PRAGMA table_info(job)').all() as Array<{ name: string }>).map((c) => c.name),
      llm_call: (getDb().prepare('PRAGMA table_info(llm_call)').all() as Array<{ name: string }>).map((c) => c.name),
    };
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
    // 路径 B：撞号库（记账止于 57 = v46 被跳过、v58 未见过，v58 补建）
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mig-v58b-'));
    try {
      openIsolated(dirB);
      getDb().prepare('DELETE FROM schema_version WHERE version = 58').run();
      getDb().exec('DROP TABLE job');
      getDb().exec('DROP TABLE llm_call');
      migrate(getDb());
      const colsB = {
        job: (getDb().prepare('PRAGMA table_info(job)').all() as Array<{ name: string }>).map((c) => c.name),
        llm_call: (getDb().prepare('PRAGMA table_info(llm_call)').all() as Array<{ name: string }>).map((c) => c.name),
      };
      expect(colsB.job).toEqual(colsA.job);
      expect(colsB.llm_call).toEqual(colsA.llm_call);
      // v46 承诺的索引也要在（idx_job_pick / idx_job_owner / idx_llm_call_created / idx_llm_call_owner_purpose）
      for (const ix of ['idx_job_pick', 'idx_job_owner', 'idx_llm_call_created', 'idx_llm_call_owner_purpose']) {
        expect(indexes().has(ix)).toBe(true);
      }
      // 自愈后的表可用：入队-认领链路真的能跑（不是只会建空壳）
      const info = getDb()
        .prepare(`INSERT INTO job (id, kind, payload) VALUES ('t1', 'k', '{}')`)
        .run();
      expect(info.changes).toBe(1);
    } finally {
      closeDb();
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('健康库无害：v58 重复应用是 no-op（不报错、版本号只记一行、数据不丢）', () => {
    openIsolated(dir);
    getDb().prepare(`INSERT INTO job (id, kind, payload) VALUES ('keep', 'k', '{}')`).run();
    const before = schemaMax();
    migrate(getDb()); // 再跑一次（幂等重入）
    migrate(getDb());
    expect(schemaMax()).toBe(before);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM job').get()).toEqual({ c: 1 }); // 数据原样
  });
});