import type { DesktopRunStatus, QuizRoundResponse } from '@sb/shared';
import { desktopEnabled } from './file-policy.js';
import { createDesktopRun, patchDesktopRun, getDesktopRun } from './task-store.js';
import { controlRun, releaseRun } from './run-control.js';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/** Observe the existing per-question agent pool without creating a second executor. */
export function beginQuizMonitor(roundId: string, index: number, owner: string | null, controller: AbortController): string | undefined {
  if (!desktopEnabled()) return;
  const rootTitle = `题组分析 · ${roundId.slice(0, 8)}`;
  let parent = (getDb().prepare('SELECT id FROM desktop_run WHERE owner_id=? AND kind=? AND prompt=? AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(ownerForWrite(owner), 'quiz', roundId) as { id: string } | undefined)?.id;
  if (!parent) parent = createDesktopRun(owner, { kind: 'quiz', title: rootTitle, prompt: roundId, status: 'running' }).id;
  patchDesktopRun(parent, owner, { status: 'running', stage: '逐题分析中' });
  const run = createDesktopRun(owner, { kind: 'quiz', parentId: parent, title: `第 ${index + 1} 题`, status: 'queued' });
  const controlled = controlRun(run.id, owner, controller.signal);
  controlled.signal.addEventListener('abort', () => { if (!controller.signal.aborted) controller.abort(controlled.signal.reason); }, { once: true });
  return run.id;
}
export function patchQuizMonitor(id: string | undefined, owner: string | null, patch: Partial<QuizRoundResponse>): void {
  if (!id) return;
  const status: DesktopRunStatus | undefined = patch.status === 'complete' ? 'completed' : patch.status === 'error' ? 'failed' : patch.status === 'cancelled' ? 'cancelled' : patch.status === 'queued' ? 'queued' : patch.status ? 'running' : undefined;
  patchDesktopRun(id, owner, { ...(status ? { status } : {}), ...(patch.status ? { stage: patch.status } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}), ...(patch.analysis !== undefined ? { result: patch.analysis } : {}) });
}
export function finishQuizMonitor(id: string | undefined, owner: string | null): void {
  if (!id) return; releaseRun(id);
  const row = getDb().prepare('SELECT parent_id AS parent FROM desktop_run WHERE id=? AND owner_id=?').get(id, ownerForWrite(owner)) as { parent: string };
  if (getDesktopRun(row.parent, owner)?.status === 'cancelled') return;
  const latest = `c.rowid=(SELECT MAX(n.rowid) FROM desktop_run n WHERE n.parent_id=c.parent_id AND n.title=c.title)`;
  const active = getDb().prepare(`SELECT COUNT(*) AS n FROM desktop_run c WHERE parent_id=? AND ${latest} AND status IN ('queued','running','waiting_permission')`).get(row.parent) as { n: number };
  if (!active.n) {
    const failures = getDb().prepare(`SELECT COUNT(*) AS n FROM desktop_run c WHERE parent_id=? AND ${latest} AND status IN ('failed','cancelled')`).get(row.parent) as { n: number };
    patchDesktopRun(row.parent, owner, { status: failures.n ? 'failed' : 'completed', stage: failures.n ? '部分题目需重试' : '题组分析完成' });
  }
}
