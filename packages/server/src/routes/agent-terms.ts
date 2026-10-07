/** 独立的 Bearer 通道；在普通 cookie/Origin 闸门之前挂载，未知路径不穿透。 */
import { Router, json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { validateAgentTermBatch } from '@sb/shared';
import { verifyAgentKey } from '../auth/agent-keys.js';
import { ownerForWrite } from '../auth/ownership.js';
import { getDb } from '../storage/db.js';
import { loadExamContext } from '../learning/exam-mode.js';
import { importAgentTerms, AgentImportConflict } from '../learning/agent-term-import.js';
import { parseAliases } from '../learning/terms.js';
import { agentTermsOpenApi } from './agent-terms-openapi.js';

const calls = new Map<string, { until: number; n: number }>();
export function resetAgentRateLimits(): void { calls.clear(); }
export const agentTermsRouter = Router();
agentTermsRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
agentTermsRouter.get('/openapi.json', (_req, res) => { res.json(agentTermsOpenApi); });
agentTermsRouter.use((req, res, next) => {
  const header = req.headers.authorization;
  const auth = typeof header === 'string' && /^Bearer /i.test(header) ? verifyAgentKey(header.slice(7).trim()) : null;
  if (!auth) { res.status(401).json({ error: '需要有效、未过期且未撤销的词条专用密钥。', code: 'INVALID_AGENT_KEY' }); return; }
  const now = Date.now();
  for (const [key, entry] of calls) if (entry.until <= now) calls.delete(key);
  const owner = ownerForWrite(auth.ownerId);
  const entry = calls.get(owner) ?? { until: now + 60000, n: 0 };
  if (entry.n >= 60) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.until - now) / 1000))));
    res.status(429).json({ error: '每个账号每分钟最多 60 次调用，请稍后重试。' }); return;
  }
  entry.n += 1; calls.set(owner, entry);
  res.locals.agentTerms = auth;
  next();
});
agentTermsRouter.use(json({ limit: '512kb' }));
function identity(res: Response): { ownerId: string | null; id: string } {
  return res.locals.agentTerms as { ownerId: string | null; id: string };
}
agentTermsRouter.get('/context', (_req, res) => {
  const { ownerId } = identity(res);
  const exam = loadExamContext(ownerId);
  const domains = getDb().prepare('SELECT name FROM term_domain WHERE owner_id = ? ORDER BY name').all(ownerForWrite(ownerId));
  res.json({ exam: { on: exam.on, summary: exam.summary, allowedHosts: exam.hosts }, domains,
    permissions: ['terms:read', 'terms:append'], maxBatchSize: 100, sourcePolicy: '来源由授权导入者提供，服务端不声称已联网核实。' });
});
agentTermsRouter.get('/terms', (req, res) => {
  const limit = Number(req.query.limit ?? 100), offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) { res.status(400).json({ error: 'limit 需要 1–200，offset 需要 0–1000000 的整数。' }); return; }
  const owner = ownerForWrite(identity(res).ownerId);
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) n FROM term_library WHERE owner_id = ?').get(owner) as { n: number }).n;
  const rows = db.prepare('SELECT id,term,definition,domain,aliases,importance FROM term_library WHERE owner_id = ? ORDER BY created_at,id LIMIT ? OFFSET ?')
    .all(owner, limit, offset) as Array<{ id: string; term: string; definition: string; domain: string; aliases: string; importance: number }>;
  res.json({ total, offset, limit, nextOffset: offset + rows.length < total ? offset + rows.length : null, terms: rows.map(r => ({ ...r, aliases: parseAliases(r.aliases) })) });
});
agentTermsRouter.post('/terms/import', (req, res) => {
  const validated = validateAgentTermBatch(req.body);
  if (!validated.ok) { res.status(400).json(validated); return; }
  const auth = identity(res);
  try { res.json(importAgentTerms(validated.value, auth.ownerId, auth.id)); }
  catch (error) {
    if (error instanceof AgentImportConflict) res.status(409).json({ error: error.message });
    else res.status(500).json({ error: '词条导入未完成，请用相同 batchId 重试。' });
  }
});
agentTermsRouter.use((_req, res) => { res.status(404).json({ error: '开放接口不存在。' }); });
agentTermsRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number } | null)?.status === 413 ? 413 : 400;
  res.status(status).json({ error: status === 413 ? '每批 JSON 最多 512 KiB。' : '请求 JSON 不合法。' });
});
