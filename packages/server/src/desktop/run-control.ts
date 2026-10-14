import { getDesktopRun, listDesktopRuns, patchDesktopRun } from './task-store.js';
import { forgetRunFileApprovals } from './file-approvals.js';
const controllers = new Map<string, { owner: string | null; controller: AbortController; cleanup: () => void }>();
export function controlRun(id: string, owner: string | null, parent?: AbortSignal): AbortController {
  const controller = new AbortController(); let cleanup = () => {};
  if (parent?.aborted) controller.abort(parent.reason);
  else if (parent) {
    const abort = () => controller.abort(parent.reason);
    cleanup = () => parent.removeEventListener('abort', abort);
    parent.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', () => parent.removeEventListener('abort', abort), { once: true });
  }
  controllers.set(id, { owner, controller, cleanup });
  return controller;
}
export function releaseRun(id: string): void { controllers.get(id)?.cleanup(); controllers.delete(id); forgetRunFileApprovals(id); }
export function cancelDesktopRun(id: string, owner: string | null): boolean {
  const run = getDesktopRun(id, owner);
  if (!run || !['queued', 'running', 'waiting_permission'].includes(run.status)) return false;
  const ids = new Set([id]); const runs = listDesktopRuns(owner);
  for (let depth = 0; depth < runs.length; depth++) for (const child of runs) if (child.parentId && ids.has(child.parentId)) ids.add(child.id);
  for (const target of ids) {
    const live = controllers.get(target);
    if (live?.owner === owner) live.controller.abort(new Error('用户已停止此任务'));
    if (['queued','running','waiting_permission'].includes(getDesktopRun(target, owner)?.status ?? ''))
      patchDesktopRun(target, owner, { status: 'cancelled', error: '用户已停止此任务，已完成的文件操作与结果保留。' });
  }
  return true;
}
