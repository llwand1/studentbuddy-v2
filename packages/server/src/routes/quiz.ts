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
import { normalizeQuizMix, normalizeAnswerStyle, mixTotal, emptyQuizImageReport, countQuizImages } from '@sb/shared';
import { roleReady } from '../llm/router.js';
import { getSessionDoc, buildDocMaterial } from '../learning/document.js';
import { upsertNoteFromAnswer } from '../learning/notes.js';
import { getDb } from '../storage/db.js';
import { publishEvent } from '../events/bus.js';
import { publish } from '../chat/sse-bus.js';

export const quizRouter = Router();

/**
 * 一键出题：{ topic, material?, sessionId?, mix?, style?, save? } → 生成→裁剪→（可选）入会话消息流→返回题目。
 * mix 省略 = 用设置页存的全局配比；传了按传的归一化（两处出题共用一套语义）。
 * style 同理：本次显式传了就覆盖库内偏好（L1 选项卡选完那一次出题靠它）。
 * 出不够不静默补题、图没出也不静默：响应带 mix / images 两份报告，UI 如实告知（ADR-5）。
 */
quizRouter.post('/generate', async (req: Request, res: Response) => {
  const { topic, material, sessionId, mix, style, search, save = true } = req.body as {
    topic?: string;
    material?: string;
    sessionId?: string;
    mix?: unknown;
    style?: unknown;
    /** 本次是否联网检索（省略＝不联网；两条 UI 入口与 PK 显式传，契约 docs/QUIZ-SEARCH-SPEC.md §2.2） */
    search?: boolean;
    save?: boolean;
  };
  // 文档模式回退（契约 5.0 §5.1-5 + §5.1.1）：未显式给材料时用本会话载入的资料出题，
  // 故必须在校验前算——否则「只传 sessionId、对话还是空的」会被误判为无材料。
  // 长资料按出题主题检索相关段落（出题拿得到 topic 作查询，§3.4）；短资料仍是全文。
  // `generateQuiz` 自带的材料上限仍是堆叠安全网，不靠它截正确内容。
  const docFallback = material?.trim() || !sessionId ? null : getSessionDoc(sessionId);
  const effectiveMaterial =
    material?.trim() || (docFallback ? buildDocMaterial(docFallback, topic ?? '') : undefined);
  if (!topic && !effectiveMaterial) {
    res.status(400).json({ error: 'topic 或 material 必填' });
    return;
  }
  try {
    const requested = mix === undefined ? loadQuizMix() : normalizeQuizMix(mix);
    // 未显式给风格时传 undefined，由 generateQuiz 自己读库内偏好（只读一处，不在此提前定级）
    const styleArg = style === undefined ? undefined : normalizeAnswerStyle(style);
    const images = emptyQuizImageReport();
    const raw = await generateQuiz(topic ?? '综合', effectiveMaterial, requested, images, styleArg, search === true);
    // 502 按**真因**分开说：v1.0 把「模型不可用 / JSON 解不出 / 配比裁空」混成一句，照着重试永远调不对（契约 §2.4）
    if (!raw) {
      // 2026-09-13 再拆一层：「出题模型压根没配」与「配了但输出没解析出来」是两条完全不同的行动指引。
      // 判定用引擎回填的 failure 真因，不在路由反推（反推在角色绑定存在但 provider 被停用等边缘态会判错）。
      const notConfigured = images.failure === 'no-model';
      res.status(502).json({
        error: notConfigured
          ? `出题失败：${roleReady('quiz-generator').reason || '出题模型没配好'}——请到「设置」→「角色模型绑定」为「出题」绑定模型后再试`
          : '出题失败：模型输出没能解析成题目（可重试；若反复失败，到设置页给「出题」换一个更强的模型）',
      });
      return;
    }
    const applied = applyQuizMix(raw, requested);
    if (!applied.quiz) {
      res.status(502).json({
        error: `出题失败：模型出的题经配比裁剪后一题不剩（要求共 ${mixTotal(requested)} 道，可重试或到设置页改配比）`,
      });
      return;
    }
    const quiz = applied.quiz;
    // 交付图数在裁剪**后**数：模型画了 3 张、被配比裁剩 1 张带图的题，就只报 1
    images.delivered = countQuizImages(quiz);
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
    res.json({ quizId, quiz, mix: applied.report, images });
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
  const { quizId, questionIndex, correct, answer } = req.body as {
    quizId?: string;
    questionIndex?: number;
    correct?: boolean;
    answer?: unknown;
  };
  if (!quizId || typeof questionIndex !== 'number' || typeof correct !== 'boolean') {
    res.status(400).json({ error: 'quizId/questionIndex/correct 必填' });
    return;
  }
  recordAnswer(quizId, questionIndex, correct);
  // 刷题笔记（QUIZ-NOTES-SPEC）：提交答案即落草稿。answer 可选（老客户端不传 = 只记对错），
  // 只收可序列化的下标数组/文本，其余形状丢弃（不可信输入不进快照）。
  let snapshot: number[] | string | undefined;
  if (Array.isArray(answer) && answer.every((a) => typeof a === 'number')) snapshot = answer as number[];
  else if (typeof answer === 'string') snapshot = answer.slice(0, 2000);
  upsertNoteFromAnswer(quizId, questionIndex, correct, snapshot ?? null);
  res.json({ ok: true });
});

quizRouter.get('/analyze/:id', (req: Request, res: Response) => {
  res.json(analyzeWeakPoints(req.params.id ?? ''));
});
