/**
 * routes/terms — 词条库薄路由（忆域 v2：AI 自动词条库）。
 * 词条：列表 / 手动存 / 按文本抽取 / 编辑 / 删除。
 * 领域（v19 起与词条 CRUD 对等）：统计 / 新建 / 改说明与改名 / 删除。
 *
 * ★ 薄路由纪律：状态码由域层（`DomainError.status`）**直通**，本文件不翻译不包装
 *   （同 `routes/choice.ts` 的头注释）。词条侧的历史写法是硬编码 400/404，未一并重构——
 *   本批只保证新增的领域口子口径统一。
 *
 * ── M2d-2（v31，2026-09-18）：词条库归主后本文件的形态 ─────────────────────────
 *
 * ★ **每个 handler 第一件事就是取 `ownerIdOf(req)` 并往下传**——本文件是词条库的**唯一 HTTP
 *   入口**，任何一处漏传都等于「该端点回到全局表行为」。★ 这里刻意**不**在文件顶部取一次
 *   然后共享：每个 handler 各取一次是**逐端点可审计**的（评审时能一眼数出 12 个端点都取了），
 *   而共享变量会让"新加一个 handler 忘了取"变成静默错误。
 * ★ 归属值一律是 `ownerIdOf(req)` 的**原样值**（`string | null`）：`null`（未登录单人模式）
 *   ⇒ 域层经 `ownerForWrite` 落成 `''` = 无主行。**不要在这里写 `?? ''`**——那与域层口径
 *   重复表达，将来口径一改就会两处不一致（见 `auth/ownership.ts`）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { listTerms, saveOneTerm, saveTerms, extractTerms, removeTerm, updateTerm } from '../learning/terms.js';
import { ownerIdOf } from '../auth/ownership.js';
import { reviewOverview, listReviewQueue, markReviewed } from '../learning/term-review.js';
// ★ 复习**范围**的写侧在 term-review-scope.ts（M2d-2 拆出，那里刻意不做 re-export 以免成环）
import { termScope, setDomainReviewScope, setTermReviewScope } from '../learning/term-review-scope.js';
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
  res.json(listTerms(domain, keyword, ownerIdOf(req)));
});

/** 领域统计（前端 Tab + 顶部统计）：含**空领域**（count=0），v19 起以登记册为准。 */
termsRouter.get('/domains', (req: Request, res: Response) => {
  res.json(domainStats(ownerIdOf(req)));
});

/**
 * 新建领域（**可零词条**）。已存在则 200 + 既有行（不覆盖 note），新建成功 201。
 * 幂等语义让「点两次新建」不会报错，UI 不必先查再建。
 * ★ 归主后「已存在」是 `(owner_id, name)`：A 建过 `物理` 不影响 B 也建 `物理`。
 */
termsRouter.post('/domains', (req: Request, res: Response) => {
  const { name, note } = req.body as { name?: string; note?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  try {
    const { row, created } = createDomain(name, note ?? '', ownerIdOf(req));
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
      res.json(renameDomainEntry(from, name, ownerIdOf(req)));
      return;
    }
    if (note === undefined) {
      res.status(400).json({ error: 'name（改名）或 note（改说明）至少给一个' });
      return;
    }
    const row = updateDomain(from, note, ownerIdOf(req));
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
    res.json(removeDomain(req.params.name ?? '', ownerIdOf(req)));
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
  const row = saveOneTerm(term, definition, domain, ownerIdOf(req));
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
  // M2c：抽取要调 explain 模型，归属取当前用户（未登录 ⇒ null = 平台通道）
  // M2d-2：落库同样按人（`saveTerms` 的第 3 参）
  const ownerId = ownerIdOf(req);
  const items = await extractTerms(body.slice(0, DOC_EXTRACT_BUDGET_CHARS), ownerId);
  if (items.length === 0) {
    res.json({ added: 0, items: [] });
    return;
  }
  const added = saveTerms(items, sourceSessionId ?? null, ownerId);
  res.json({ added, items });
});

/**
 * 复习打卡（v23 艾宾浩斯）：`remembered: true` 推进一个节点，`false` 归零重来。
 * ★ `remembered` **必须是布尔**（不接受 `"true"` 字符串）：这里没有「没填」的合理默认——
 *   猜成记住会让用户白丢一次复习，猜成忘了会让阶段倒退；**这种二选一的字段一律显式**。
 * ★ v28 起先判**复习范围**：范围外的词条拒绝打卡（409），否则会出现"库里记了一次复习、
 *   而页面上它根本不显示"的静默错账。404 与 409 分开给：前者是"词条没了，刷新列表"，
 *   后者是"你没把它纳入复习，先去勾选"——两种处置完全不同，压成一个码前端就没法提示。
 */
termsRouter.post('/:id/review', (req: Request, res: Response) => {
  const remembered = (req.body as { remembered?: unknown } | undefined)?.remembered;
  if (typeof remembered !== 'boolean') {
    res.status(400).json({ error: 'remembered 必填且必须是布尔值' });
    return;
  }
  const id = req.params.id ?? '';
  const ownerId = ownerIdOf(req);
  const scope = termScope(id, ownerId);
  if (!scope) {
    res.status(404).json({ error: '词条不存在' });
    return;
  }
  if (!scope.inScope) {
    res.status(409).json({ error: '该词条未纳入复习范围，请先在复习范围里勾选它（或其所属领域）' });
    return;
  }
  const row = markReviewed(id, remembered, ownerId);
  if (!row) {
    res.status(404).json({ error: '词条不存在' });
    return;
  }
  res.json(row);
});

/** 复习概览（今日欠账 + 阶段分布 + 近 7 天复习量）。放在 `/:id` 之前，免得被路径参数吞掉。 */
termsRouter.get('/review/overview', (req: Request, res: Response) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
  res.json(reviewOverview(domain, ownerIdOf(req)));
});

/** 今日复习队列（按逾期天数降序 = 先还旧账）。`limit` 的归一在域层，这里不自己钳。 */
termsRouter.get('/review/queue', (req: Request, res: Response) => {
  const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
  const raw = Number(req.query.limit);
  res.json(listReviewQueue(Number.isFinite(raw) ? raw : undefined, domain, ownerIdOf(req)));
});

/**
 * 设复习范围（v28，契约 `docs/EBBINGHAUS-SPEC.md` §9）：**选择式复习**的唯一写口。
 * `{ domain, enabled }` = 领域开关；`{ termId, enabled }` = 单条词条。二者**必须恰好给一个**。
 *
 * ★ `enabled` 是**目标有效值**（"这条以后复不复"），不是"往列里写什么"——
 *   该写 `NULL`（继承领域）还是写显式 0/1，由域层按"是否偏离领域默认"决定
 *   （见 `setTermReviewScope`）。让调用方自己决定写哪一列，等于把优先级规则漏给前端。
 * ★ 两个都给 ⇒ 400 而不是"两个都改"：调用方多半是拼错了，猜一个会让它以为另一个也生效了
 *   （同 `remembered` 必须显式布尔的取向：**二选一的字段不接受猜测**）。
 */
termsRouter.put('/review/scope', (req: Request, res: Response) => {
  const { domain, termId, enabled } = req.body as { domain?: unknown; termId?: unknown; enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled 必填且必须是布尔值' });
    return;
  }
  const hasDomain = typeof domain === 'string' && domain.trim() !== '';
  const hasTerm = typeof termId === 'string' && termId.trim() !== '';
  if (hasDomain === hasTerm) {
    res.status(400).json({ error: 'domain 与 termId 必须二选一（且都要非空）' });
    return;
  }
  const ownerId = ownerIdOf(req);
  if (hasDomain) {
    const r = setDomainReviewScope(domain as string, enabled, ownerId);
    if (!r) {
      res.status(404).json({ error: `没有名为「${domain}」的领域` });
      return;
    }
    res.json(r);
    return;
  }
  const r = setTermReviewScope(termId as string, enabled, ownerId);
  if (!r) {
    res.status(404).json({ error: '词条不存在' });
    return;
  }
  res.json(r);
});

termsRouter.put('/:id', (req: Request, res: Response) => {
  const { definition, domain, importance } = req.body as { definition?: string; domain?: string; importance?: number };
  const row = updateTerm(req.params.id ?? '', { definition, domain, importance }, ownerIdOf(req));
  if (!row) {
    res.status(404).json({ error: '词条不存在' });
    return;
  }
  res.json(row);
});

termsRouter.delete('/:id', (req: Request, res: Response) => {
  removeTerm(req.params.id ?? '', ownerIdOf(req));
  res.json({ ok: true });
});
