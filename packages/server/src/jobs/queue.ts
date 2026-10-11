/**
 * jobs/queue — **持久化后台任务队列**（`job` 表，v46）：入队、认领、完成、失败退避、重启恢复、列表。
 *
 * ★ 为什么不用内存队列：改前「对话结束后抽词 + 压缩」是 `void promise`——
 *   上游抖一下就静默失败，这一轮的词条永远补不回来；进程重启时在途的也一起蒸发。
 *   落库之后：失败按退避重试（最多 `max_attempts` 次），重启后卡在 running 的放回 queued。
 * ★ 单进程 + SQLite：认领用一条 `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`，
 *   better-sqlite3 同步执行，天然没有两个 worker 抢到同一行的问题。
 * ★ `dedupe_key` 唯一：同一件事重复入队只落一行（`INSERT OR IGNORE`）。
 */
import { randomUUID } from 'node:crypto';
import type { JobStatus } from '@sb/shared';
import { getDb } from '../storage/db.js';

export interface JobRow {
  id: string;
  owner_id: string | null;
  kind: string;
  dedupe_key: string | null;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueInput {
  kind: string;
  ownerId: string | null;
  payload: unknown;
  dedupeKey?: string;
  maxAttempts?: number;
  /** 最早执行时间（毫秒时间戳）；缺省立即 */
  runAfter?: number;
}

/** 入队；返回任务 id。去重键撞上已有行时返回 null（那件事已经在队里或做过了） */
export function enqueueJob(input: EnqueueInput): string | null {
  const id = randomUUID();
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO job (id, owner_id, kind, dedupe_key, payload, max_attempts, run_after)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.ownerId, input.kind, input.dedupeKey ?? null, JSON.stringify(input.payload ?? {}), input.maxAttempts ?? 3, input.runAfter ?? 0);
  return info.changes > 0 ? id : null;
}

/** 认领一条到期的任务（queued 且 run_after ≤ now），原子地置为 running 并 attempts+1 */
export function claimJob(now = Date.now()): JobRow | null {
  const row = getDb()
    .prepare(
      `UPDATE job SET status = 'running', attempts = attempts + 1, updated_at = datetime('now')
        WHERE id = (SELECT id FROM job WHERE status = 'queued' AND run_after <= ? ORDER BY run_after, created_at LIMIT 1)
        RETURNING *`,
    )
    .get(now) as JobRow | undefined;
  return row ?? null;
}

export function completeJob(id: string): void {
  getDb().prepare(`UPDATE job SET status = 'done', last_error = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
}

/** 退避：第 n 次失败后等 `30s × 4^(n-1)`（30s、2min、8min…），封顶 1 小时 */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 4 ** Math.max(attempts - 1, 0), 3_600_000);
}

/**
 * 记一次失败：还有次数 ⇒ 回到 queued 并推迟；用完或 `permanent` ⇒ failed。
 * ★ `permanent` 给"重试也没用"的失败（例如没配模型）——白白重试三次只会多记三行失败账。
 */
export function failJob(row: Pick<JobRow, 'id' | 'attempts' | 'max_attempts'>, error: string, permanent = false, now = Date.now()): 'queued' | 'failed' {
  const give = permanent || row.attempts >= row.max_attempts;
  getDb()
    .prepare(`UPDATE job SET status = ?, last_error = ?, run_after = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(give ? 'failed' : 'queued', error.slice(0, 500), give ? 0 : now + backoffMs(row.attempts), row.id);
  return give ? 'failed' : 'queued';
}

/** 启动恢复：上次进程退出时还在 running 的任务放回 queued（它们的 Promise 已随进程消失） */
export function recoverStaleJobs(): number {
  return getDb().prepare(`UPDATE job SET status = 'queued', updated_at = datetime('now') WHERE status = 'running'`).run().changes;
}

/**
 * `job` 表是否就绪（查 sqlite_master，一次索引查询，刻意**不缓存**）。
 *
 * 为什么需要它：2026-10-10 真机事故——迁移号 46 在两条线上各定义过一次（旧线建
 * review_log+learning_event，主干建 llm_call+learning_event+job），被旧线先迁移过的库
 * `schema_version` 记了 46 ⇒ 主干永远跳过 v46 ⇒ `job` 表缺失 ⇒ `startJobWorker`
 * 里的 `recoverStaleJobs()` 抛 `no such table: job` ⇒ **整个服务起不来**。
 * 修复两层：v58 幂等补表（治本）+ 本守卫（纵深防御：再有表被漏掉时，坏的是队列功能，
 * 不是整个服务）。不缓存的理由：`startJobWorker` 一辈子只调一次，缓存只会在测试里
 * 制造「DROP 后查不到、重建后查不回」的假状态。
 */
export function jobTableReady(): boolean {
  return !!getDb().prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'job'`).get();
}

/** 清理：完成超过 `days` 天的任务行（失败的留更久，便于排查） */
export function pruneJobs(days = 7): number {
  return getDb()
    .prepare(
      `DELETE FROM job WHERE (status = 'done' AND updated_at < datetime('now', ?)) OR (status = 'failed' AND updated_at < datetime('now', ?))`,
    )
    .run(`-${days} days`, `-${days * 4} days`).changes;
}

/**
 * ★ 归属按 `owner_id IS ?` 比：任务行存的是**原始** ownerId（本地单人模式为 NULL）——处理函数要拿它
 *   原样去路由模型（`routeRole` 对 null 与 '' 走的是两条路），所以入队时不能归一化成 ''。
 */
export function listJobs(ownerId: string | null, limit = 20): JobRow[] {
  return getDb()
    .prepare('SELECT * FROM job WHERE owner_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(ownerId, Math.min(Math.max(limit, 1), 100)) as JobRow[];
}

export function jobCounts(ownerId: string | null): Record<JobStatus, number> {
  const out: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  const rows = getDb().prepare('SELECT status, COUNT(*) AS c FROM job WHERE owner_id IS ? GROUP BY status').all(ownerId) as Array<{ status: JobStatus; c: number }>;
  for (const r of rows) out[r.status] = r.c;
  return out;
}

/** 手动重试一条失败的任务（设置页「重试」按钮）；只认自己的、只认 failed */
export function retryJob(id: string, ownerId: string | null): boolean {
  return (
    getDb()
      .prepare(`UPDATE job SET status = 'queued', attempts = 0, run_after = 0, updated_at = datetime('now') WHERE id = ? AND owner_id IS ? AND status = 'failed'`)
      .run(id, ownerId).changes > 0
  );
}
