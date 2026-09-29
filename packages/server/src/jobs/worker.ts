/**
 * jobs/worker — 后台任务的**执行器**：处理函数登记、单进程轮询、失败分类。
 *
 * ★ 两种运行形态，由 `startJobWorker()` 有没有被调用决定：
 *   - 服务进程（`index.ts` 直接运行时启动）：`dispatchJob` 入库 + 立刻唤醒轮询 ⇒ 持久、可重试；
 *   - 单测 / 被当库导入：worker 没启动，`dispatchJob` **直接内联执行**处理函数（fire-and-forget）
 *     ⇒ 与改前的 `void promise` 行为逐字一致，既有测试不用因为"多了个队列"而改。
 * ★ 处理函数抛 `PermanentJobError` ⇒ 不再重试（例如没配模型）；抛别的 ⇒ 按退避重试。
 */
import { claimJob, completeJob, enqueueJob, failJob, recoverStaleJobs, type EnqueueInput } from './queue.js';

export class PermanentJobError extends Error {}

export type JobHandler = (payload: unknown, ctx: { ownerId: string | null; attempt: number }) => Promise<void>;

interface HandlerInfo {
  label: string;
  run: JobHandler;
}

const handlers = new Map<string, HandlerInfo>();

export function registerJobHandler(kind: string, label: string, run: JobHandler): void {
  handlers.set(kind, { label, run });
}

export function jobLabel(kind: string): string {
  return handlers.get(kind)?.label ?? kind;
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/** 执行一条已认领的任务（导出给测试：不必真起轮询也能验证"失败→退避→失败封顶"整条链） */
export async function runClaimed(row: NonNullable<ReturnType<typeof claimJob>>): Promise<'done' | 'queued' | 'failed'> {
  const h = handlers.get(row.kind);
  if (!h) {
    failJob(row, `没有登记处理函数：${row.kind}`, true);
    return 'failed';
  }
  let payload: unknown = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    failJob(row, '任务载荷损坏', true);
    return 'failed';
  }
  try {
    await h.run(payload, { ownerId: row.owner_id, attempt: row.attempts });
    completeJob(row.id);
    return 'done';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return failJob(row, msg, e instanceof PermanentJobError);
  }
}

/** 把当前到期的任务逐条跑完（串行：后台任务都要打模型，并发只会互相抢上游配额） */
export async function drainJobs(max = 20): Promise<number> {
  if (busy) return 0;
  busy = true;
  let n = 0;
  try {
    for (; n < max; n += 1) {
      const row = claimJob();
      if (!row) break;
      await runClaimed(row);
    }
  } finally {
    busy = false;
  }
  return n;
}

export function startJobWorker(intervalMs = 5_000): void {
  if (running) return;
  running = true;
  const recovered = recoverStaleJobs();
  // eslint-disable-next-line no-console -- 进程启动日志
  if (recovered > 0) console.log(`[jobs] 已把 ${recovered} 条重启前未完成的任务放回队列`);
  timer = setInterval(() => void drainJobs(), intervalMs);
  timer.unref?.();
  void drainJobs();
}

export function stopJobWorker(): void {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}

export function jobWorkerRunning(): boolean {
  return running;
}

/**
 * 派发一件后台任务：worker 在跑 ⇒ 入库并立刻唤醒；没在跑（单测/库导入）⇒ 内联执行、吞掉错误。
 */
export function dispatchJob(input: EnqueueInput): void {
  if (running) {
    enqueueJob(input);
    setImmediate(() => void drainJobs());
    return;
  }
  const h = handlers.get(input.kind);
  if (!h) return;
  void h.run(input.payload, { ownerId: input.ownerId, attempt: 1 }).catch(() => undefined);
}
