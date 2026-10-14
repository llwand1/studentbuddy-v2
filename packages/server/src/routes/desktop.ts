import { asyncHandler } from '../http/async-handler.js';
import { Router, json, type Request, type Response, type NextFunction } from 'express';
import { parseDesktopStudySettings } from '@sb/shared';
import { canAccessSession, sessionExists, ownerIdOf } from '../auth/ownership.js';
import { browserStore } from '../desktop/browser-store.js';
import { saveStudySettings, studyClock } from '../desktop/study.js';
import { loadWorkspace, saveWorkspace } from '../desktop/workspace.js';
import { desktopWorkbenchRouter } from './desktop-workbench.js';
import { browserPreference, openReaderBrowser, savePreferredBrowser } from '../desktop/browser-launch.js';

/** Never exposed by the hosted website; verify the actual socket, host and launch marker. */
export function desktopGuard(req: Request, res: Response, next: NextFunction): void {
  const peer = req.socket.remoteAddress;
  const host = req.get('host') ?? '';
  if (process.env.SB_DESKTOP !== '1' || !['127.0.0.1', '::1'].includes(process.env.SB_HOST ?? '127.0.0.1') ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
    res.status(404).json({ error: '此功能仅在本机安装包中可用' }); return;
  }
  res.setHeader('Cache-Control', 'no-store'); next();
}
export const desktopBridgeRouter = Router();
desktopBridgeRouter.use(desktopGuard);
// This route has its own capability boundary; never relax the application's origin policy.
desktopBridgeRouter.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { res.status(403).json({ error: '仅浏览器共读扩展可连接' }); return; }
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).end(); return;
  }
  next();
});
desktopBridgeRouter.use(json({ limit: '800kb' }));
desktopBridgeRouter.post('/pair', (req, res) => {
  const code: unknown = req.body?.code;
  const token = typeof code === 'string' && /^[a-fA-F0-9]{10}$/.test(code) ? browserStore.pair(code) : null;
  if (!token) { res.status(401).json({ error: '配对码无效、过期或尝试过多，请重新生成' }); return; }
  res.json({ token });
});
desktopBridgeRouter.use((req, res, next) => {
  const token = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const connection = browserStore.connection(token);
  if (!connection) { res.status(401).json({ error: '连接已结束，请重新配对' }); return; }
  if (!sessionExists(connection.sessionId) || !canAccessSession(connection.sessionId, connection.owner)) {
    browserStore.clear(connection.owner); res.status(404).json({ error: '共读对话已删除' }); return;
  }
  res.locals.browserToken = token; next();
});
desktopBridgeRouter.post('/page', (req, res) => {
  if (!browserStore.update(String(res.locals.browserToken), req.body)) { res.status(409).json({ error: '页面数据无效或已被更新的快照取代' }); return; }
  res.json({ ok: true });
});
desktopBridgeRouter.delete('/page', (req, res) => {
  const epoch: unknown = req.body?.epoch;
  if (epoch !== undefined && (typeof epoch !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(epoch))) { res.status(400).json({ error: '页面标识无效' }); return; }
  browserStore.dropPage(String(res.locals.browserToken), epoch); res.json({ ok: true });
});
desktopBridgeRouter.delete('/connection', (_req, res) => {
  const c = browserStore.connection(String(res.locals.browserToken));
  if (c) browserStore.clear(c.owner);
  res.json({ ok: true });
});

export const desktopRouter = Router();
desktopRouter.use(desktopGuard);
desktopRouter.use('/workbench', desktopWorkbenchRouter);
desktopRouter.get('/browser/preference', (req, res) => res.json(browserPreference(ownerIdOf(req))));
desktopRouter.post('/browser/preference', (req, res) => {
  try { savePreferredBrowser(ownerIdOf(req), req.body?.browser); res.json(browserPreference(ownerIdOf(req))); }
  catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : '浏览器选择失败' }); }
});
desktopRouter.post('/browser/open', asyncHandler(async (req, res) => {
  const id: unknown = req.body?.sessionId, owner = ownerIdOf(req);
  if (typeof id !== 'string' || !sessionExists(id) || !canAccessSession(id, owner)) { res.status(404).json({error:'请先选择一个本机对话'}); return; }
  try {
    const code = browserStore.pairCode(owner, id);
    const port = req.socket.localPort;
    await openReaderBrowser(owner, `http://127.0.0.1:${port}/desktop-reader-connect.html#${code}`);
    res.json({ok:true});
  } catch (e) { res.status(400).json({error:e instanceof Error ? e.message : '浏览器打开失败'}); }
}));
desktopRouter.get('/workspace', (req, res) => res.json(loadWorkspace(ownerIdOf(req))));
desktopRouter.post('/workspace', (req, res) => {
  const id: unknown = req.body?.sessionId;
  if (id !== null && (typeof id !== 'string' || id.length > 128)) { res.status(400).json({ error: '对话标识无效' }); return; }
  const owner = ownerIdOf(req);
  if (id !== null && (!sessionExists(id) || !canAccessSession(id, owner))) { res.status(404).json({ error: '对话不存在' }); return; }
  saveWorkspace(owner, id); res.json(loadWorkspace(owner));
});
desktopRouter.get('/study', (req, res) => res.json(studyClock(ownerIdOf(req)).state()));
desktopRouter.post('/study', (req, res) => {
  const settings = parseDesktopStudySettings(req.body);
  if (!settings) { res.status(400).json({ error: '间隔需为 1–60 分钟，并选择出题范围' }); return; }
  saveStudySettings(ownerIdOf(req), settings); res.json(studyClock(ownerIdOf(req)).state());
});
desktopRouter.post('/study/tick', (req, res) => res.json(studyClock(ownerIdOf(req)).tick(req.body?.eligible === true)));
desktopRouter.post('/study/dismiss', (req, res) => {
  const action: unknown = req.body?.action;
  if (action !== 'done' && action !== 'skip' && action !== 'snooze') { res.status(400).json({ error: '操作无效' }); return; }
  studyClock(ownerIdOf(req)).dismiss(action); res.json(studyClock(ownerIdOf(req)).state());
});
desktopRouter.get('/browser', (req, res) => res.json({ page: browserStore.state(ownerIdOf(req), req.query.text === '1') }));
desktopRouter.post('/browser/pair-code', (req, res) => {
  const id: unknown = req.body?.sessionId;
  if (typeof id !== 'string' || !sessionExists(id) || !canAccessSession(id, ownerIdOf(req))) { res.status(404).json({ error: '请先选择一个本机对话' }); return; }
  res.json({ code: browserStore.pairCode(ownerIdOf(req), id), endpoint: `http://${req.get('host')}`, expiresIn: 300 });
});
desktopRouter.delete('/browser', (req, res) => { browserStore.clear(ownerIdOf(req)); res.json({ ok: true }); });
