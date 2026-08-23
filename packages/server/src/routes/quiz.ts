/**
 * routes/quiz — 练+析薄路由。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { generateQuiz, saveQuiz, listQuiz, getQuiz, deleteQuiz, recordAnswer, analyzeWeakPoints } from '../learning/quiz.js';
import { getDb } from '../storage/db.js';
import { publish } from '../chat/sse-bus.js';

export const quizRouter = Router();

/** 一键出题：{ topic, material?, sessionId? } → 生成→（可选）入会话消息流→返回题目 */
quizRouter.post('/generate', async (req: Request, res: Response) => {
  const { topic, material, sessionId, save = true } = req.body as {
    topic?: string;
    material?: string;
    sessionId?: string;
    save?: boolean;
  };
  if (!topic && !material) {
    res.status(400).json({ error: 'topic 或 material 必填' });
    return;
  }
  try {
    const quiz = await generateQuiz(topic ?? '综合', material);
    if (!quiz) {
      res.status(502).json({ error: '出题失败：模型输出未遵循协议（可重试）' });
      return;
    }
    let quizId: string | undefined;
    if (save) quizId = saveQuiz(quiz, 'ai');
    if (sessionId) {
      // 内容块流（演进③）：quiz 经 SSE block 事件下发聊天视图
      publish(sessionId, {
        type: 'block',
        sessionId,
        blockId: `quiz-${quizId ?? Date.now()}`,
        done: true,
        payload: { kind: 'quiz', blockId: `quiz-${quizId ?? Date.now()}`, payload: quiz },
      });
      getDb()
        .prepare(`INSERT INTO messages (id, session_id, role, content, tokens) VALUES (?, ?, 'assistant', ?, ?)`)
        .run(`m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sessionId, `[QUIZ]${JSON.stringify(quiz)}[/QUIZ]`, 0);
    }
    res.json({ quizId, quiz });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

quizRouter.get('/bank', (_req, res) => {
  res.json(listQuiz());
});

quizRouter.get('/bank/:id', (req: Request, res: Response) => {
  const quiz = getQuiz(req.params.id ?? '');
  if (!quiz) {
    res.status(404).json({ error: '题库不存在' });
    return;
  }
  const stats = getDb()
    .prepare('SELECT question_index, attempts, correct, streak, best_streak FROM quiz_stats WHERE quiz_id = ?')
    .all(req.params.id ?? '');
  res.json({ quiz, stats });
});

quizRouter.delete('/bank/:id', (req: Request, res: Response) => {
  deleteQuiz(req.params.id ?? '');
  res.json({ ok: true });
});

quizRouter.post('/stats/record', (req: Request, res: Response) => {
  const { quizId, questionIndex, correct } = req.body as { quizId?: string; questionIndex?: number; correct?: boolean };
  if (!quizId || typeof questionIndex !== 'number' || typeof correct !== 'boolean') {
    res.status(400).json({ error: 'quizId/questionIndex/correct 必填' });
    return;
  }
  recordAnswer(quizId, questionIndex, correct);
  res.json({ ok: true });
});

quizRouter.get('/analyze/:id', (req: Request, res: Response) => {
  res.json(analyzeWeakPoints(req.params.id ?? ''));
});
