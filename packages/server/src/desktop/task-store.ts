import { randomUUID } from 'node:crypto';
import type { DesktopRun, DesktopRunStatus, DesktopRunEvent } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

interface Row {
  id: string; parent_id: string | null; session_id: string | null; kind: DesktopRun['kind']; title: string; prompt: string;
  capability: DesktopRun['capability']; status: DesktopRunStatus; stage: string; model: string;
  tasks: string; result: string; error: string; created_at: number; updated_at: number;
}
function view(row: Row): DesktopRun {
  return { id: row.id, parentId: row.parent_id, sessionId: row.session_id, kind: row.kind, title: row.title, prompt: row.prompt,
    capability: row.capability, status: row.status, stage: row.stage, model: row.model, tasks: JSON.parse(row.tasks),
    result: row.result, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function createDesktopRun(owner: string | null, data: Pick<DesktopRun, 'kind' | 'title'> & Partial<DesktopRun>): DesktopRun {
  const id = randomUUID(), now = Date.now();
  getDb().prepare(`INSERT INTO desktop_run(id,owner_id,parent_id,session_id,kind,title,prompt,capability,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, ownerForWrite(owner), data.parentId ?? null, data.sessionId ?? null,
      data.kind, data.title.slice(0, 120), data.prompt?.slice(0, 12000) ?? '', data.capability ?? 'read_only', data.status ?? 'queued', now, now);
  return getDesktopRun(id, owner)!;
}
export function getDesktopRun(id: string, owner: string | null): DesktopRun | null {
  const row = getDb().prepare('SELECT * FROM desktop_run WHERE id=? AND owner_id=?').get(id, ownerForWrite(owner)) as Row | undefined;
  return row ? view(row) : null;
}
export function listDesktopRuns(owner: string | null): DesktopRun[] {
  return (getDb().prepare(`SELECT * FROM desktop_run WHERE owner_id=? ORDER BY updated_at DESC LIMIT 200`)
    .all(ownerForWrite(owner)) as Row[]).map(view);
}
export function patchDesktopRun(id: string, owner: string | null, patch: Partial<Pick<DesktopRun, 'status' | 'stage' | 'model' | 'tasks' | 'result' | 'error'>>): void {
  const fields = Object.entries(patch).filter(([key]) => ['status','stage','model','tasks','result','error'].includes(key));
  if (!fields.length) return;
  getDb().prepare(`UPDATE desktop_run SET ${fields.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=? AND owner_id=?`)
    .run(...fields.map(([key, value]) => key === 'tasks' ? JSON.stringify(value) : String(value).slice(0, key === 'result' ? 24000 : 1000)), Date.now(), id, ownerForWrite(owner));
}
export function recoverDesktopRuns(): void {
  getDb().prepare(`UPDATE desktop_run SET status='interrupted', error='应用曾被中断；可手动重试，不自动重放文件写入。',updated_at=?
    WHERE status IN ('queued','running','waiting_permission')`).run(Date.now());
  getDb().prepare(`UPDATE desktop_file_approval SET status='expired' WHERE status='pending'`).run();
}
export function recordRunEvent(id: string, owner: string | null, summary: string): void {
  if (!getDesktopRun(id, owner)) return;
  getDb().prepare('INSERT INTO desktop_run_event(run_id,owner_id,summary,created_at) VALUES(?,?,?,?)')
    .run(id, ownerForWrite(owner), summary.slice(0, 1000), Date.now());
}
export function desktopRunEvents(id: string, owner: string | null): DesktopRunEvent[] {
  return getDb().prepare('SELECT id,summary,created_at AS createdAt FROM desktop_run_event WHERE run_id=? AND owner_id=? ORDER BY id DESC LIMIT 100')
    .all(id, ownerForWrite(owner)) as DesktopRunEvent[];
}
