/**
 * routes/quiz — 练+析薄路由。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  generateQuiz,
  saveQuiz,
  listQuiz,
  getQuiz,
  deleteQuiz,
  recordAnswer,
  analyzeWeakPoints,
  loadQuizMix,
  applyQuizMix,
} from '../learning/quiz.js';
import { normalizeQuizMix } from '@sb/shared';
import { getSessionDoc } from '../learning/document.js';
import { getDb } from '../storage/db.js';
import { publishEvent } from '../events/bus.js';
import { publish } from '../chat/sse-bus.js';

export const quizRouter = Router();

/**
 * 一键出题：{ topic, material?, sessionId?, mix?, save? } → 生成→裁剪→（可选）入会话消息流→返回题目。
 * mix 省略 = 用设置页存的全局配比；传了按传的归一化（两处出题共用一套语义）。
 * 出不够不静默补题：响应带 mix 报告，UI 如实告知缺哪类（ADR-5）。
 */
quizRouter.post('/generate', async (req: Request, res: Response) => {
  const { topic, material, sessionId, mix, save = true } = req.body as {
    topic?: string;
    material?: string;
    sessionId?: string;
    mix?: unknown;
    save?: boolean;
  };
  // 文档模式回退（契约 5.0 §5.1-5）：未显式给材料时用本会话载入的资料出题，
  // 故必须在校验前算——否则「只传 sessionId、对话还是空的」会被误判为无材料。
  // 截断不在这里做：generateQuiz 自带 60k 材料上限，两处各截会互相掩盖。
  const docFallback = material?.trim() || !sessionId ? null : getSessionDoc(sessionId);
  const effectiveMaterial = material?.trim() || docFallback?.text;
  if (!topic && !effectiveMaterial) {
    res.status(400).json({ error: 'topic 或 material 必填' });
    return;
  }
  try {
    const requested = mix === undefined ? loadQuizMix() : normalizeQuizMix(mix);
    const raw = await generateQuiz(topic ?? '综合', effectiveMaterial, requested);
    const applied = raw ? applyQuizMix(raw, requested) : null;
    if (!applied?.quiz) {
      res.status(502).json({ error: '出题失败：模型输出未遵循协议或没出中要求的题型（可重试）' });
      return;
    }
    const quiz = applied.quiz;
    let quizId: string | undefined;
    if (save) quizId = saveQuiz(quiz, 'ai');
    if (quizId) publishEvent({ type: 'quiz_generated', quizId });
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
    res.json({ quizId, quiz, mix: applied.report });
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
