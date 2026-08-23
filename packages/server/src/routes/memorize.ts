/**
 * routes/memorize — 背背背薄路由。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { listTerms, addTerm, addTermsBatch, removeTerm, dueQueue, reviewTerm, stats } from '../learning/memorize.js';
import type { SrsQuality } from '../learning/srs.js';

export const memorizeRouter = Router();

memorizeRouter.get('/', (req: Request, res: Response) => {
  res.json(listTerms(typeof req.query.category === 'string' ? req.query.category : undefined));
});

memorizeRouter.get('/stats', (_req, res) => {
  res.json(stats());
});

memorizeRouter.get('/due', (req: Request, res: Response) => {
  const limit = Number(req.query.limit ?? 50) || 50;
  res.json(dueQueue(new Date(), limit));
});

memorizeRouter.post('/', (req: Request, res: Response) => {
  const { term, definition, category, items } = req.body as {
    term?: string;
    definition?: string;
    category?: string;
    items?: Array<{ term: string; definition: string; category?: string }>;
  };
  if (Array.isArray(items)) {
    res.json({ added: addTermsBatch(items) });
    return;
  }
  if (!term?.trim() || !definition?.trim()) {
    res.status(400).json({ error: 'term 与 definition 必填' });
    return;
  }
  res.status(201).json({ id: addTerm(term.trim(), definition.trim(), category?.trim() || undefined) });
});

memorizeRouter.post('/:id/review', (req: Request, res: Response) => {
  const { quality } = req.body as { quality?: number };
  if (![1, 3, 4, 5].includes(Number(quality))) {
    res.status(400).json({ error: 'quality 必须是 1/3/4/5' });
    return;
  }
  const r = reviewTerm(req.params.id ?? '', quality as SrsQuality, new Date());
  if (!r) {
    res.status(404).json({ error: '词条不存在' });
    return;
  }
  res.json(r);
});

memorizeRouter.delete('/:id', (req: Request, res: Response) => {
  removeTerm(req.params.id ?? '');
  res.json({ ok: true });
});
