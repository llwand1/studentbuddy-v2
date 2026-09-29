/**
 * jobs/maintenance — 每日维护：清理旧的任务行与模型调用账（让两张只增表不无限长大）。
 *
 * ★ 走任务队列本身而不是裸 `setInterval`：去重键按**本地日期**（`maintenance:YYYY-MM-DD`），
 *   一天只落一行；进程一天重启几次也只跑一次，而且跑没跑、失败原因都看得见。
 */
import { localDayKey } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { enqueueJob, pruneJobs } from './queue.js';
import { registerJobHandler } from './worker.js';

export const MAINTENANCE_JOB = 'system.maintenance';
/** 调用账保留天数（统计卡最多看 90 天） */
export const LLM_CALL_KEEP_DAYS = 90;

export function pruneLlmCalls(days = LLM_CALL_KEEP_DAYS): number {
  return getDb().prepare(`DELETE FROM llm_call WHERE created_at < datetime('now', ?)`).run(`-${days} days`).changes;
}

registerJobHandler(MAINTENANCE_JOB, '每日维护', async () => {
  pruneJobs();
  pruneLlmCalls();
});

export function scheduleMaintenance(now = new Date()): string | null {
  return enqueueJob({ kind: MAINTENANCE_JOB, ownerId: null, payload: {}, dedupeKey: `maintenance:${localDayKey(now)}`, maxAttempts: 2 });
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startMaintenance(): void {
  if (timer) return;
  scheduleMaintenance();
  timer = setInterval(() => scheduleMaintenance(), 6 * 3_600_000);
  timer.unref?.();
}
