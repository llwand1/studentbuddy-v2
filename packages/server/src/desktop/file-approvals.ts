import { randomUUID } from 'node:crypto';
import type { DesktopFileApproval } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { patchDesktopRun, getDesktopRun } from './task-store.js';

export interface FileContext { owner: string | null; runId?: string; signal?: AbortSignal; writeAllowed?: boolean; }
interface Waiter { owner: string; runId?: string; settle: (allowed: boolean, status: DesktopFileApproval['status']) => void; }
const waiters = new Map<string, Waiter>();
const deniedFiles = new Map<string, Set<string>>();
const TTL = 5 * 60_000;
export async function askFileApproval(ctx: FileContext, file: string, operation: DesktopFileApproval['operation'], reason: string): Promise<void> {
  ctx.signal?.throwIfAborted();
  const canonical = process.platform === 'win32' ? file.toLowerCase() : file;
  if (ctx.runId && deniedFiles.get(ctx.runId)?.has(canonical)) throw new Error('用户已拒绝本任务访问这个文件；不会再次申请。');
  if (waiters.size >= 100) throw new Error('待授权操作过多，请先处理已有许可');
  const id = randomUUID(), expires = Date.now() + TTL;
  const previous = ctx.runId ? getDesktopRun(ctx.runId, ctx.owner)?.status : undefined;
  if (ctx.runId) patchDesktopRun(ctx.runId, ctx.owner, { status: 'waiting_permission', stage: `等待${operation === 'read' ? '读取' : operation === 'list' ? '列出' : '写入'}敏感文件许可` });
  const allowed = await new Promise<boolean>(resolve => {
    const onAbort = () => settle(false, 'denied');
    const timer = setTimeout(() => settle(false, 'expired'), TTL); timer.unref?.();
    const settle = (allow: boolean, status: DesktopFileApproval['status']) => {
      if (!waiters.delete(id)) return;
      clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort);
      getDb().prepare('UPDATE desktop_file_approval SET status=? WHERE id=?').run(status, id);
      if (!allow && ctx.runId) { const denied = deniedFiles.get(ctx.runId) ?? new Set<string>(); denied.add(canonical); deniedFiles.set(ctx.runId, denied); }
      resolve(allow);
    };
    waiters.set(id, { owner: ownerForWrite(ctx.owner), runId: ctx.runId, settle });
    getDb().prepare(`INSERT INTO desktop_file_approval(id,owner_id,run_id,path,operation,reason,status,expires_at) VALUES(?,?,?,?,?,?,'pending',?)`)
      .run(id, ownerForWrite(ctx.owner), ctx.runId ?? null, file, operation, reason, expires);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal?.aborted) onAbort();
  });
  if (ctx.runId && getDesktopRun(ctx.runId, ctx.owner)?.status === 'waiting_permission') patchDesktopRun(ctx.runId, ctx.owner, { status: previous === 'queued' ? 'queued' : 'running', stage: allowed ? '已获得本次许可' : '用户未批准文件访问' });
  ctx.signal?.throwIfAborted();
  if (!allowed) throw new Error('用户未批准本次敏感文件访问；不要重复申请或改路径绕过。');
}
export function forgetRunFileApprovals(id: string): void { deniedFiles.delete(id); for (const pending of waiters.values()) if (pending.runId === id) pending.settle(false, 'denied'); }
export function decideFileApproval(id: string, owner: string | null, allow: boolean): boolean {
  const waiter = waiters.get(id);
  if (!waiter || waiter.owner !== ownerForWrite(owner)) return false;
  const row = getDb().prepare('SELECT expires_at FROM desktop_file_approval WHERE id=?').get(id) as { expires_at: number };
  if (row.expires_at <= Date.now()) { waiter.settle(false, 'expired'); return false; }
  waiter.settle(allow, allow ? 'allowed' : 'denied'); return true;
}
export function listFileApprovals(owner: string | null): DesktopFileApproval[] {
  return (getDb().prepare(`SELECT id,run_id AS runId,path,operation,reason,status,expires_at AS expiresAt
    FROM desktop_file_approval WHERE owner_id=? AND status='pending' AND expires_at>? ORDER BY expires_at`)
    .all(ownerForWrite(owner), Date.now()) as DesktopFileApproval[]);
}
