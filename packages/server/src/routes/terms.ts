/**
 * routes/terms — 词条库薄路由（忆域 v2：AI 自动词条库）。
 * 词条：列表 / 手动存 / 按文本抽取 / 编辑 / 删除。
 * 领域（v19 起与词条 CRUD 对等）：统计 / 新建 / 改说明与改名 / 删除。
 *
 * ★ 薄路由纪律：状态码由域层（`DomainError.status`）**直通**，本文件不翻译不包装
 *   （同 `routes/choice.ts` 的头注释）。词条侧的历史写法是硬编码 400/404，未一并重构——
 *   本批只保证新增的领域口子口径统一。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { listTerms, saveOneTerm, saveTerms, extractTerms, removeTerm, updateTerm } from '../learning/terms.js';
import { reviewOverview, listReviewQueue, markReviewed } from '../learning/term-review.js';
import {
  createDomain,
  updateDomain,
  renameDomainEntry,
  removeDomain,
  domainStats,
  DomainError,
} from '../learning/domains.js';
import { getSessionDoc, buildDocMaterial } from '../learning/document.js';
import { DOC_EXTRACT_BUDGET_CHARS } from '@sb/shared';

export const termsRouter = Router();

/** 领域操作统一错误应答：域层给状态码，这里只落 HTTP。 */
function fail(res: Response, err: unknown): void {
  const status = err instanceof DomainError ? err.status : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

termsRouter.get('/', (req: Request, res: Response) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
  const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
  res.json(listTerms(domain, keyword));
});

/** 领域统计（前端 Tab + 顶部统计）：含**空领域**（count=0），v19 起以登记册为准。 */
termsRouter.get('/domains', (_req, res) => {
  res.json(domainStats());
});

/**
 * 新建领域（**可零词条**）。已存在则 200 + 既有行（不覆盖 note），新建成功 201。
 * 幂等语义让「点两次新建」不会报错，UI 不必先查再建。
 */
termsRouter.post('/domains', (req: Request, res: Response) => {
  const { name, note } = req.body as { name?: string; note?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  try {
    const { row, created } = createDomain(name, note ?? '');
    res.status(created ? 201 : 200).json(row);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * 改领域：带 `name` ⇒ **改名**（词条批量迁到新领域，目标已存在则两域合一）；只带 `note` ⇒ 改说明。
 * ⚠️ `:name` 是**领域名本身**（可含中文/空格），Express 已对路径参数做过解码，
 *   不要再 `decodeURIComponent`（会二次解码，含 `%` 的领域名直接炸）。
 */
termsRouter.put('/domains/:name', (req: Request, res: Response) => {
  const from = req.params.name ?? '';
  const { name, note } = req.body as { name?: string; note?: string };
  try {
    if (name?.trim()) {
      res.json(renameDomainEntry(from, name));
      return;
    }
    if (note === undefined) {
      res.status(400).json({ error: 'name（改名）或 note（改说明）至少给一个' });
      return;
    }
    const row = updateDomain(from, note);
    if (!row) {
      res.status(404).json({ error: `没有名为「${from}」的领域` });
      return;
    }
    res.json(row);
  } catch (err) {
    fail(res, err);
  }
});

/** 删领域：词条迁 `general`（**不删词条**），响应含迁移条数。`general` 本身拒绝删除（409）。 */
termsRouter.delete('/domains/:name', (req: Request, res: Response) => {
  try {
    res.json(removeDomain(req.params.name ?? ''));
  } catch (err) {
    fail(res, err);
  }
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
  // 文档模式回退（契约 5.0 §5.1-5 + DOC-RAG-SPEC §3.4）：未给文本时用该会话载入的资料抽词条。
  // 传空查询 ⇒ 走**均匀覆盖全文**而不是检索：抽词条没有查询，要的是覆盖面不是相关度，
  // 拿 BM25 做这件事会把词条抽成「跟某个词最像的那几段」。旧行为是只送前 30k 字，
  // 长资料后段从未被抽过；新行为是同体量（≈DOC_EXTRACT_BUDGET_CHARS）但横跨全文。
  const doc = sourceSessionId ? getSessionDoc(sourceSessionId) : null;
  const body = text?.trim() || (doc ? buildDocMaterial(doc, '') : '');
  if (!body) {
    res.status(400).json({ error: 'text 必填（或先为本会话载入资料）' });
    return;
  }
  const items = await extractTerms(body.slice(0, DOC_EXTRACT_BUDGET_CHARS));
  if (items.length === 0) {
    res.json({ added: 0, items: [] });
    return;
  }
  const added = saveTerms(items, sourceSessionId ?? null);
  res.json({ added, items });
});

/**
 * 复习打卡（v23 艾宾浩斯）：`remembered: true` 推进一个节点，`false` 归零重来。
 * ★ `remembered` **必须是布尔**（不接受 `"true"` 字符串）：这里没有「没填」的合理默认——
 *   猜成记住会让用户白丢一次复习，猜成忘了会让阶段倒退；**这种二选一的字段一律显式**。
 */
termsRouter.post('/:id/review', (req: Request, res: Response) => {
  const remembered = (req.body as { remembered?: unknown } | undefined)?.remembered;
  if (typeof remembered !== 'boolean') {
    res.status(400).json({ error: 'remembered 必填且必须是布尔值' });
    return;
  }
  const row = markReviewed(req.params.id ?? '', remembered);
  if (!row) {
    res.status(404).json({ error: '词条不存在' });
    return;
  }
  res.json(row);
});

/** 复习概览（今日欠账 + 阶段分布 + 近 7 天复习量）。放在 `/:id` 之前，免得被路径参数吞掉。 */
termsRouter.get('/review/overview', (req: Request, res: Response) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
  res.json(reviewOverview(domain));
});

/** 今日复习队列（按逾期天数降序 = 先还旧账）。`limit` 的归一在域层，这里不自己钳。 */
termsRouter.get('/review/queue', (req: Request, res: Response) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
  const raw = Number(req.query.limit);
  res.json(listReviewQueue(Number.isFinite(raw) ? raw : undefined, domain));
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
