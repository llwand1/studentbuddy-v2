/**
 * routes/notes — 刷题笔记薄路由（ADR-3：校验 + 调 service，零业务逻辑）。
 * 草稿的产生不在本路由：POST /api/quiz/stats/record 提交答案时自动 upsert（见 learning/notes.ts），
 * 这里只管列表 / 详情 / 写心得 / 删除。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { listNotes, getNote, updateNoteBody, deleteNote, MAX_NOTE_BODY } from '../learning/notes.js';
import { ownerIdOf } from '../auth/ownership.js';

export const notesRouter = Router();

notesRouter.get('/', (req: Request, res: Response) => {
  const quizId = typeof req.query.quizId === 'string' && req.query.quizId ? req.query.quizId : undefined;
  const wrong = req.query.wrong === '1' || req.query.wrong === 'true';
  res.json(listNotes(ownerIdOf(req), { quizId, wrong }));
});

notesRouter.get('/:id', (req: Request, res: Response) => {
  const note = getNote(req.params.id ?? '', ownerIdOf(req));
  if (!note) {
    res.status(404).json({ error: '笔记不存在' });
    return;
  }
  res.json(note);
});

notesRouter.put('/:id', (req: Request, res: Response) => {
  const { body } = (req.body ?? {}) as { body?: unknown };
  if (typeof body !== 'string') {
    res.status(400).json({ error: 'body（心得正文）必填且为字符串' });
    return;
  }
  if (body.length > MAX_NOTE_BODY) {
    res.status(400).json({ error: `心得过长（上限 ${MAX_NOTE_BODY} 字）` });
    return;
  }
  if (!updateNoteBody(req.params.id ?? '', body, ownerIdOf(req))) {
    res.status(404).json({ error: '笔记不存在' });
    return;
  }
  res.json({ ok: true });
});

notesRouter.delete('/:id', (req: Request, res: Response) => {
  deleteNote(req.params.id ?? '', ownerIdOf(req));
  res.json({ ok: true });
});
