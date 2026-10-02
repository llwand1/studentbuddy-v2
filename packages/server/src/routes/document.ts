/**
 * routes/document — 文档模式薄路由（契约 5.0 §5.1-5）。
 * GET    /api/doc?sessionId=          → { doc: DocMeta | null }（只回元信息，永不回原文）
 * POST   /api/doc {sessionId,name,text} → { doc: DocMeta }（同会话重复 POST＝整篇替换）
 * POST   /api/doc/url {sessionId,url} → { doc: DocMeta, source: {...} }（网页资料，§10）
 * DELETE /api/doc?sessionId=          → { ok: true }
 *
 * 正文只在 POST 时过一次网络，读取一律只回 name/chars/truncated——刷新重绘不需要 60k 文本。
 * 扩展名不在此校验：粘贴进来的文本本就没有文件名，格式约束留在 UI（accept=".txt,.md"）。
 * 也不落盘：文本进 sessions.doc_text，故无 multer/上传目录/路径穿越面。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { canAccessSession, ownerIdOf, sessionExists } from '../auth/ownership.js';
import { getSessionDoc, setSessionDoc, clearSessionDoc, docMeta } from '../learning/document.js';
import { fetchDocFromUrl } from '../learning/doc-url.js';

export const documentRouter = Router();

function sessionIdOf(req: Request): string {
  const q = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  const b = req.body && typeof req.body.sessionId === 'string' ? req.body.sessionId : '';
  return (q || b).trim();
}

documentRouter.get('/', (req: Request, res: Response) => {
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  // ★ 别人的会话与不存在同形 → 404（不学本地模式回 {doc:null}：那等于答"这个会话存在、只是没资料"）
  if (!canAccessSession(sessionId, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ doc: docMeta(getSessionDoc(sessionId, ownerIdOf(req))) });
});

documentRouter.post('/', (req: Request, res: Response) => {
  const { name, text } = req.body as { name?: string; text?: string };
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  if (!text?.trim()) {
    res.status(400).json({ error: '资料正文不能为空' });
    return;
  }
  const doc = setSessionDoc(sessionId, (name ?? '').trim(), text, ownerIdOf(req));
  if (!doc) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ doc: docMeta(doc) });
});

/**
 * 网页资料（契约 §10）：给一个网址，服务端抓正文、组装成本会话资料。
 *
 * 为什么**不让前端抓完再 POST 正文**：① 浏览器跨源抓不到绝大多数站点；
 * ② 真抓得到也不该信——那等于前端可以往会话资料里塞任何正文并声称来自某网址。
 * 抓取只在服务端、只走 `fetchSafe`，这一条和资料溯源的阅读页同口径。
 *
 * ★ **先判会话再出网，而且归属断言不够、必须补存在性断言**：
 *   `canAccessSession` 在未登录单人模式（`ownerId === null`）下**不查库直接放行**
 *   （那是刻意的旧行为兼容，见 `auth/ownership.ts`）。别的写端点漏判的后果是留一条孤儿行；
 *   **本端点漏判的后果是出网**——随便编一个 sessionId 就能驱动本服务器去抓任意网址。
 *   抓取本身有 `fetchSafe` 兜底（内网一律拦），但「替不存在的会话跑一趟外网」这件事
 *   本身就不该发生：它白送一次出站能力与放大面。故按 `sessionExists` 注释里那条
 *   「写端点要在归属断言之外再补一道存在性断言」的既有规矩办，闸门排在 `fetchDocFromUrl` 之前。
 */
documentRouter.post('/url', async (req: Request, res: Response) => {
  const { url } = req.body as { url?: string };
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  if (!canAccessSession(sessionId, ownerIdOf(req)) || !sessionExists(sessionId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const got = await fetchDocFromUrl(url ?? '');
  if (!got.ok) {
    res.status(got.status).json({ error: got.error });
    return;
  }
  const { draft } = got;
  const doc = setSessionDoc(sessionId, draft.name, draft.text, ownerIdOf(req));
  if (!doc) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  // 回执带 source：前端要显示「这份资料来自哪一页」和「截没截」，但**正文照旧不回显**
  res.json({
    doc: docMeta(doc),
    source: { url: draft.url, title: draft.title, site: draft.site, sourceChars: draft.sourceChars, clipped: draft.clipped },
  });
});

documentRouter.delete('/', (req: Request, res: Response) => {
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  if (!clearSessionDoc(sessionId, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ ok: true });
});
