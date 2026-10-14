import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { ownerIdOf } from '../auth/ownership.js';
import { workspaceInfo, chooseWorkspace, protectPath } from '../desktop/file-policy.js';
import { listDesktopRuns, getDesktopRun, desktopRunEvents } from '../desktop/task-store.js';
import { launchDesktopAgent } from '../desktop/agent-runner.js';
import { cancelDesktopRun } from '../desktop/run-control.js';
import { listFileApprovals, decideFileApproval } from '../desktop/file-approvals.js';
import { listComputerFiles, readComputerFile, writeWorkspaceFile } from '../desktop/files.js';
import { jobCounts, listJobs } from '../jobs/queue.js';
import { jobLabel } from '../jobs/worker.js';
export const desktopWorkbenchRouter = Router();
type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => asyncHandler((req, res) => Promise.resolve().then(() => fn(req, res))
  .catch(error => { if (!res.headersSent && !res.destroyed) res.status(400).json({ error: error instanceof Error ? error.message : '操作失败' }); }));
desktopWorkbenchRouter.get('/state', wrap((req, res) => {
  const owner = ownerIdOf(req);
  res.json({ workspace: workspaceInfo(owner), runs: listDesktopRuns(owner), approvals: listFileApprovals(owner),
    jobs: listJobs(owner, 20).map(j => ({ id: j.id, label: jobLabel(j.kind), status: j.status, attempts: j.attempts, error: j.last_error })), jobCounts: jobCounts(owner) });
}));
desktopWorkbenchRouter.put('/workspace', wrap((req, res) => {
  if (typeof req.body?.path !== 'string') throw new Error('请选择工作区目录');
  res.json(chooseWorkspace(ownerIdOf(req), req.body.path));
}));
desktopWorkbenchRouter.post('/protected-paths', wrap((req, res) => {
  if (typeof req.body?.path !== 'string' || typeof req.body.protect !== 'boolean') throw new Error('敏感位置设置无效');
  protectPath(ownerIdOf(req), req.body.path, req.body.protect); res.json(workspaceInfo(ownerIdOf(req)));
}));
desktopWorkbenchRouter.post('/tasks', wrap((req, res) => {
  if (typeof req.body?.prompt !== 'string' || !['read_only','workspace_write'].includes(req.body.capability)) throw new Error('任务描述或权限无效');
  const launched = launchDesktopAgent(ownerIdOf(req), req.body.prompt, req.body.capability);
  res.status(202).json(launched.run);
}));
desktopWorkbenchRouter.get('/tasks/:id', wrap((req, res) => {
  const owner = ownerIdOf(req), run = getDesktopRun(req.params.id ?? '', owner);
  if (!run) { res.status(404).json({ error: '任务不存在' }); return; }
  res.json({ run, events: desktopRunEvents(run.id, owner) });
}));
desktopWorkbenchRouter.post('/tasks/:id/cancel', wrap((req, res) => {
  if (!cancelDesktopRun(req.params.id ?? '', ownerIdOf(req))) { res.status(409).json({ error: '任务已结束或不可取消' }); return; }
  res.json({ ok: true });
}));
desktopWorkbenchRouter.post('/tasks/:id/retry', wrap((req, res) => {
  const owner = ownerIdOf(req), original = getDesktopRun(req.params.id ?? '', owner);
  if (!original || original.kind !== 'agent' || !['failed','cancelled','interrupted'].includes(original.status)) { res.status(409).json({ error: '此任务不能单独重试；对话和题解请回原界面重试' }); return; }
  res.status(202).json(launchDesktopAgent(owner, original.prompt, original.capability, undefined, original.sessionId ?? undefined).run);
}));
desktopWorkbenchRouter.post('/approvals/:id', wrap((req, res) => {
  if (typeof req.body?.allow !== 'boolean') throw new Error('只能选择允许一次或拒绝');
  if (!decideFileApproval(req.params.id ?? '', ownerIdOf(req), req.body.allow)) { res.status(409).json({ error: '授权请求已失效' }); return; }
  res.json({ ok: true });
}));
for (const action of ['list','read','write'] as const) desktopWorkbenchRouter.post(`/files/${action}`, wrap(async (req, res) => {
  if (typeof req.body?.path !== 'string') throw new Error('路径无效');
  if (action === 'write' && typeof req.body.content !== 'string') throw new Error('写入内容必须是文本');
  const controller = new AbortController();
  const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('文件操作已取消')); };
  res.once('close', disconnect);
  try {
    const ctx = { owner: ownerIdOf(req), signal: controller.signal, writeAllowed: true };
    const data = action === 'list' ? await listComputerFiles(ctx, req.body.path) : action === 'read' ? await readComputerFile(ctx, req.body.path) : await writeWorkspaceFile(ctx, req.body.path, req.body.content);
    if (!res.destroyed) res.json(data);
  } finally { res.removeListener('close', disconnect); }
}));
