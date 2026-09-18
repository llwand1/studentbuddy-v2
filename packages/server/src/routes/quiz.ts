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
  loadQuizMix,
  applyQuizMix,
} from '../learning/quiz.js';
import { analyzeWeakPoints } from '../learning/quiz-weak.js';
import { collectQuiz, normalizeCollectedQuiz } from '../learning/collect.js';
import { announceScenarioToSession, generateScenario } from '../learning/scenario.js';
import { emptyScenarioGenReport } from '../learning/scenario-protocol.js';
import { deleteScenarioDemoByQuiz } from '../learning/scenario.js';
import {
  normalizeQuizMix,
  normalizeAnswerStyle,
  mixTotal,
  emptyQuizImageReport,
  countQuizImages,
  emptyCollectReport,
  type ScenarioMixResult,
} from '@sb/shared';
import { roleReady } from '../llm/router.js';
import { getSessionDoc, buildDocMaterial } from '../learning/document.js';
import { upsertNoteFromAnswer } from '../learning/notes.js';
import { getDb } from '../storage/db.js';
import { publishEvent } from '../events/bus.js';
import { publish } from '../chat/sse-bus.js';
import { ownerIdOf } from '../auth/ownership.js';

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
    const requested = mix === undefined ? loadQuizMix(ownerIdOf(req)) : normalizeQuizMix(mix);
    // 情景档（SCENARIO-SPEC §6.1）：五档一张配比卡，但传统四类走一道引擎、情景题走独立引擎
    const scenarioCount = requested.scenario;
    const tradTotal = mixTotal(requested) - scenarioCount;

    /** 逐套生成情景题：每套成功即广播+进会话流，失败如实记账不整体作废（ADR-5） */
    const genScenarios = async (count: number): Promise<ScenarioMixResult[]> => {
      const results: ScenarioMixResult[] = [];
      for (let i = 0; i < count; i++) {
        const report = emptyScenarioGenReport();
        // M2c：情景题生成是一次 LLM 调用，归属取当前用户（未登录 ⇒ null = 平台通道）
        const gen = await generateScenario(topic ?? '综合', effectiveMaterial, report, ownerIdOf(req));
        if (!gen) {
          results.push({ ok: false, failure: report.failure ?? 'parse' });
          continue;
        }
        publishEvent({ type: 'quiz_generated', quizId: gen.quizId, ownerId: ownerIdOf(req) });
        if (sessionId) announceScenarioToSession(sessionId, gen);
        results.push({ ok: true, quizId: gen.quizId, demoId: gen.demoId });
      }
      return results;
    };

    // 纯情景配比：传统四档全 0 时不跑传统引擎——喂全 0 配比只会得到空题组 → 假 502
    if (tradTotal === 0) {
      const scenarios = await genScenarios(scenarioCount);
      const zeros = { single: 0, multiple: 0, fill: 0, essay: 0 };
      res.json({
        scenarios,
        images: emptyQuizImageReport(),
        mix: { requested: { ...zeros }, actual: { ...zeros }, matched: true },
      });
      return;
    }

    const images = emptyQuizImageReport();

    // 未显式给风格时传 undefined，由 generateQuiz 自己读库内偏好（只读一处，不在此提前定级）
    const styleArg = style === undefined ? undefined : normalizeAnswerStyle(style);
    const raw = await generateQuiz(topic ?? '综合', effectiveMaterial, requested, images, styleArg, search === true, ownerIdOf(req));
    // 502 按**真因**分开说：v1.0 把「模型不可用 / JSON 解不出 / 配比裁空」混成一句，照着重试永远调不对（契约 §2.4）
    if (!raw) {
      // 2026-09-13 再拆一层：「出题模型压根没配」与「配了但输出没解析出来」是两条完全不同的行动指引。
      // 判定用引擎回填的 failure 真因，不在路由反推（反推在角色绑定存在但 provider 被停用等边缘态会判错）。
      const notConfigured = images.failure === 'no-model';
      res.status(502).json({
        error: notConfigured
          ? `出题失败：${roleReady('quiz-generator', ownerIdOf(req)).reason || '出题模型没配好'}——请到「设置」→「角色模型绑定」为「出题」绑定模型后再试`
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
    if (quizId) publishEvent({ type: 'quiz_generated', quizId, ownerId: ownerIdOf(req) });
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
    // 情景档在传统题之后逐套出（顺序即 MIX_KINDS 档位序）；每套成败如实进响应
    const scenarios = scenarioCount > 0 ? await genScenarios(scenarioCount) : undefined;
    res.json({ quizId, quiz, mix: applied.report, images, ...(scenarios ? { scenarios } : {}) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 现场搜集·预览（契约 docs/RESOURCE-SPEC.md §3.5）：跑「检索→抓页→模型摘题→verbatim 锁」全程，
 * **绝不落库**——commit 只发生在人于预览界面勾选确认之后（外部结果永不直接写库，TOOL-ECOSYSTEM 先例）。
 * 报告全程如实带回（搜集词/逐源失败/逐页记账/逐题 verdict），前端只念不判（ADR-5）。
 */
quizRouter.post('/collect/preview', async (req: Request, res: Response) => {
  const { topic } = req.body as { topic?: string };
  if (!topic?.trim()) {
    res.status(400).json({ error: 'topic 必填——想练什么主题的题，说个主题' });
    return;
  }
  try {
    const report = emptyCollectReport();
    const r = await collectQuiz(topic.trim(), report, { ownerId: ownerIdOf(req) });
    // 「没配模型」与「搜到抓到现场没题」是两条不同行动指引，文案分开（同 /generate 的 failure 口径）
    if (report.failure === 'no-model') {
      res.status(502).json({
        error: `搜集失败：${roleReady('quiz-generator', ownerIdOf(req)).reason || '出题模型没配好'}——请到「设置」→「角色模型绑定」为「出题」绑定模型后再试`,
      });
      return;
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 现场搜集·入库：用户在预览里确认过的题组 → `saveQuiz(quiz,'collect')`。
 * ★ 不信任客户端的 ok 标记——服务端复跑形状 + 可判分闸门（`normalizeCollectedQuiz`）；
 *   verbatim 不在此重验（页面原文已不在场），预览机验 + 入库人验两道叠加即契约设计。
 */
quizRouter.post('/collect/commit', (req: Request, res: Response) => {
  const { title, questions } = req.body as { title?: string; questions?: unknown };
  const quiz = normalizeCollectedQuiz(title, questions);
  if (!quiz) {
    res.status(400).json({ error: '入库失败：没有一道通过服务端复校验（请先预览，再勾选确认的题提交）' });
    return;
  }
  const quizId = saveQuiz(quiz, 'collect');
  publishEvent({ type: 'quiz_generated', quizId, ownerId: ownerIdOf(req) });
  res.json({ quizId, count: quiz.questions.length });
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
  // 情景题连带删 demo 行（quiz_bank 无外键，1:1 关系靠这里维持；普通题删零行幂等）
  deleteScenarioDemoByQuiz(req.params.id ?? '');
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

/**
 * 薄弱点分析（契约 docs/QUIZ-WEAK-SPEC.md）：**AI 实时生成**，走 analyzer 角色。
 * ★ 必须 try/catch：Express 4 不接管 async 路由的 rejection，漏了会让请求永久挂起
 *   （域层已兜住模型调用，这里兜的是 DB / 未知异常，ADR-4 失败隔离）。
 * ★ 失败真因由域层填（`fallback` / `failure`），本路由只透传、**不反推**——
 *   反推在「角色绑定存在但 provider 被停用」这类边缘态会判错。
 */
quizRouter.get('/analyze/:id', async (req: Request, res: Response) => {
  try {
    // M2c：薄弱点分析要调 analyzer 模型，归属取当前用户
    res.json(await analyzeWeakPoints(req.params.id ?? '', ownerIdOf(req)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
