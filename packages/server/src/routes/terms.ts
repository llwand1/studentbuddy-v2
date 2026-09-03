/**
 * routes/terms — 词条库薄路由（忆域 v2：AI 自动词条库）。
 * 列表/领域统计/手动存/按文本抽取/编辑/删除。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  listTerms,
  domainStats,
  saveOneTerm,
  saveTerms,
  extractTerms,
  removeTerm,
  updateTerm,
} from '../learning/terms.js';
import { getSessionDoc } from '../learning/document.js';

export const termsRouter = Router();

termsRouter.get('/', (req: Request, res: Response) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
  res.json(listTerms(domain, keyword));
});

termsRouter.get('/domains', (_req, res) => {
  res.json(domainStats());
});

/** 手动存一条（列表页「添加」/ 对话外补录）。 */
termsRouter.post('/', (req: Request, res: Response) => {
  const { term, definition, domain } = req.body as { term?: string; definition?: string; domain?: string };
  if (!term?.trim() || !definition?.trim()) {
    res.status(400).json({ error: 'term 与 definition 必填' });
    return;
  }
  const row = saveOneTerm(term, definition, domain);
  res.status(201).json(row);
});

/** 按文本抽取并入库（对话「存入记忆」按钮 / 文档模式抽词条 / 调试用）。 */
termsRouter.post('/extract', async (req: Request, res: Response) => {
  const { text, sourceSessionId } = req.body as { text?: string; sourceSessionId?: string };
  // 文档模式回退（契约 5.0 §5.1-5）：未给文本时用该会话载入的资料抽词条
  const body = text?.trim() || (sourceSessionId ? getSessionDoc(sourceSessionId)?.text || '' : '');
  if (!body) {
    res.status(400).json({ error: 'text 必填（或先为本会话载入资料）' });
    return;
  }
  const items = await extractTerms(body.slice(0, 30000));
  if (items.length === 0) {
    res.json({ added: 0, items: [] });
    return;
  }
  const added = saveTerms(items, sourceSessionId ?? null);
  res.json({ added, items });
});

termsRouter.put('/:id', (req: Request, res: Response) => {
  const { definition, domain, importance } = req.body as { definition?: string; domain?: string; importance?: number };
  const row = updateTerm(req.params.id ?? '', { definition, domain, importance });
  if (!row) {
    res.status(404).json({ error: '词条不存在' });
    return;
  }
  res.json(row);
});

termsRouter.delete('/:id', (req: Request, res: Response) => {
  removeTerm(req.params.id ?? '');
  res.json({ ok: true });
});
