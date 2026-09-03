/**
 * routes/document — 文档模式薄路由（契约 5.0 §5.1-5）。
 * GET    /api/doc?sessionId=          → { doc: DocMeta | null }（只回元信息，永不回原文）
 * POST   /api/doc {sessionId,name,text} → { doc: DocMeta }（同会话重复 POST＝整篇替换）
 * DELETE /api/doc?sessionId=          → { ok: true }
 *
 * 正文只在 POST 时过一次网络，读取一律只回 name/chars/truncated——刷新重绘不需要 60k 文本。
 * 扩展名不在此校验：粘贴进来的文本本就没有文件名，格式约束留在 UI（accept=".txt,.md"）。
 * 也不落盘：文本进 sessions.doc_text，故无 multer/上传目录/路径穿越面。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSessionDoc, setSessionDoc, clearSessionDoc, docMeta } from '../learning/document.js';

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
  res.json({ doc: docMeta(getSessionDoc(sessionId)) });
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
  const doc = setSessionDoc(sessionId, (name ?? '').trim(), text);
  if (!doc) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ doc: docMeta(doc) });
});

documentRouter.delete('/', (req: Request, res: Response) => {
  const sessionId = sessionIdOf(req);
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  if (!clearSessionDoc(sessionId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ ok: true });
});
