import { Router } from 'express';
import { parseOpenerRequest } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import { generateCampfireOpener } from '../learning/campfire-opener.js';

export const campfireOpenerRouter = Router();
campfireOpenerRouter.post('/opener', async (req, res) => {
  const parsed = parseOpenerRequest(req.body);
  if (!parsed) { res.status(400).json({ error: '召题请求不合法' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  const controller = new AbortController();
  const disconnect = (): void => { if (!res.writableEnded) controller.abort(); };
  res.on('close', disconnect);
  const timer = setTimeout(() => controller.abort(), 42_000);
  try {
    const result = await generateCampfireOpener(ownerIdOf(req), parsed.exclude, controller.signal);
    if (res.destroyed) return;
    if (controller.signal.aborted) { res.status(504).json({ error: '召题超时，点一下重新试试。' }); return; }
    if (result.ok) res.json(result.value);
    else res.status(result.status).json({ error: result.error });
  } catch {
    if (!res.destroyed) res.status(500).json({ error: '召题暂时失败，点一下重新试试。' });
  } finally { clearTimeout(timer); res.off('close', disconnect); }
});
