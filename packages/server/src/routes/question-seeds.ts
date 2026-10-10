/** 在共用的开放 Bearer / 限流 / JSON 闸门之后挂载。 */
import { Router } from 'express';
import { validateQuestionSeedBatch } from '@sb/shared';
import { agentPermissions } from '../auth/agent-keys.js';
import { importSeeds, listSeeds, removeSeed, seedView, SeedImportError } from '../learning/question-seeds.js';

export const questionSeedsRouter = Router();
questionSeedsRouter.use((req, res, next) => {
  const auth = res.locals.agentTerms as { ownerId: string | null; id: string };
  const permission = req.method === 'GET' ? 'question-seeds:read' : 'question-seeds:write';
  if (!agentPermissions(auth.ownerId, auth.id).includes(permission)) { res.status(403).json({ error: '此密钥只有词条权限，请在设置页显式授权出题预产物后创建新密钥。', code: 'SEED_PERMISSION_REQUIRED' }); return; }
  next();
});
questionSeedsRouter.get('/', (req, res) => {
  const limit = Number(req.query.limit ?? 100), offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) { res.status(400).json({ error: '分页参数不合法。' }); return; }
  const { ownerId } = res.locals.agentTerms as { ownerId: string | null };
  const all = listSeeds(ownerId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  res.json({ total: all.length, limit, offset, nextOffset: offset + limit < all.length ? offset + limit : null, seeds: all.slice(offset, offset + limit).map(r => seedView(r, ownerId)) });
});
questionSeedsRouter.post('/import', (req, res) => {
  const r = validateQuestionSeedBatch(req.body, Date.now(), false);
  if (!r.ok) { res.status(400).json(r); return; }
  try { res.json(importSeeds(r.value, (res.locals.agentTerms as { ownerId: string | null }).ownerId)); }
  catch (error) {
    if (error instanceof SeedImportError) res.status(error.status).json({ error: error.message });
    else res.status(500).json({ error: '导入未完成，请用相同 batchId 重试。' });
  }
});
questionSeedsRouter.delete('/:id', (req, res) => {
  const { ownerId } = res.locals.agentTerms as { ownerId: string | null };
  if (!removeSeed(ownerId, req.params.id)) { res.status(404).json({ error: '预产物不存在。' }); return; }
  res.json({ ok: true });
});
