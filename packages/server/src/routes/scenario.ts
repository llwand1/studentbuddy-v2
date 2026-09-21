/**
 * routes/scenario — 情景题薄路由（契约 docs/SCENARIO-SPEC.md §4，2026-09-17 新建）。
 * 域逻辑在 learning/scenario.ts，本文件只做 HTTP 映射：入参缺项 400、demo/task 不存在 404，
 * 状态码由域层返回的真因映射，不反推（同 routes/choice.ts 手法）。
 *
 * ★ 出页响应头与 preview 同一套账：CSP `sandbox`（刻意不给 allow-same-origin ⇒ demo 源为 null，
 *   调不动写接口）+ X-Frame-Options 放宽到 SAMEORIGIN（全局 DENY 会把宿主面板一起挡掉）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { buildScenarioDemoPage, announceScenarioToSession, generateScenario, getScenarioDemoId, reportScenario, saveScenario } from '../learning/scenario.js';
import { emptyScenarioGenReport } from '../learning/scenario-protocol.js';
import { roleReady } from '../llm/router.js';
import { publishEvent } from '../events/bus.js';
import { ownerIdOf } from '../auth/ownership.js';

export const scenarioRouter = Router();

/** 按套题反查 demoId（题库 JSON 不存 demoId；前端从题库页打开面板前先换 id）。别人的套题 → 404。 */
scenarioRouter.get('/by-quiz/:quizId', (req: Request, res: Response) => {
  const demoId = getScenarioDemoId(req.params.quizId ?? '', ownerIdOf(req));
  if (!demoId) {
    res.status(404).json({ error: '该套题没有情景 demo（可能不是情景题或已损坏）' });
    return;
  }
  res.json({ demoId });
});

/**
 * 登记一套情景题（M1 手工/测试入口；M2 起出题引擎改走域层 saveScenario，同一条 normalize 闸门）。
 * body { title, html, tasks } → { quizId, demoId }；评分点无 criteria / html 缺失超限 → 400。
 */
scenarioRouter.post('/seed', (req: Request, res: Response) => {
  const { title, html, tasks } = req.body as { title?: unknown; html?: unknown; tasks?: unknown };
  const saved = saveScenario({ title, tasks }, html, ownerIdOf(req));
  if (!saved) {
    res.status(400).json({ error: '登记失败：title/tasks/html 缺失、tasks 无合法评分点（每条须带 criteria）或 html 超限' });
    return;
  }
  res.json(saved);
});

/**
 * AI 生成一套情景题（M2，契约 §6）：{ topic, material?, sessionId? } → 引擎走 SCENARIO_PROTOCOL 双标记协议，
 * 解析救援阶梯 + saveScenario 一次落库（情景题不落库就没有 demo 可玩，故不设 save 开关）。
 * 502 按**真因**分开说（与 quiz generate 同口径）：没配模型给绑定指引，解析失败给换模型建议。
 * 带 sessionId 时照 quiz generate 的分支把题卡推进聊天流：SSE block 事件 + 历史落库（M3，契约 §8）。
 * 历史文本 = [SCENARIO]{payload 顶层 + quizId/demoId 两个登记键}[/SCENARIO]——登记键只进聊天消息
 * content（还原卡片要用），不进 quiz_bank data（那边保持纯契约形状）。
 */
scenarioRouter.post('/generate', async (req: Request, res: Response) => {
  const { topic, material, sessionId } = req.body as { topic?: string; material?: string; sessionId?: string };
  if (!topic?.trim() && !material?.trim()) {
    res.status(400).json({ error: 'topic 或 material 必填' });
    return;
  }
  const report = emptyScenarioGenReport();
  try {
    const gen = await generateScenario(topic?.trim() || '综合', material?.trim() || undefined, report, ownerIdOf(req));
    if (!gen) {
      const notConfigured = report.failure === 'no-model';
      res.status(502).json({
        error: notConfigured
          ? `出题失败：${roleReady('quiz-generator', ownerIdOf(req)).reason || '出题模型没配好'}——请到「设置」→「角色模型绑定」为「出题」绑定模型后再试`
          : '情景题生成失败：模型输出没能解析成情景题（可重试；若反复失败，到设置页给「出题」换一个更强的模型）',
        report,
      });
      return;
    }
    publishEvent({ type: 'quiz_generated', quizId: gen.quizId, ownerId: ownerIdOf(req) });
    if (sessionId) announceScenarioToSession(sessionId, gen);
    res.json({ quizId: gen.quizId, demoId: gen.demoId, payload: gen.payload, report });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** 出 demo 页（宿主面板 iframe 与浏览器直开共用）：404 用 HTML 提示，保持 type 一致。别人的 demo → 404。 */
scenarioRouter.get('/demo/:id', (req: Request, res: Response) => {
  const page = buildScenarioDemoPage(req.params.id ?? '', ownerIdOf(req));
  res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-modals allow-forms');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (!page) {
    res.status(404).type('html').send('<meta charset="utf-8">情景题不存在或已被删除。');
    return;
  }
  res.type('html').send(page);
});

/**
 * 回传对错：{ demoId, taskId, observed } → 白名单 → 服务端判分 → quiz_stats。
 * ★ 判分结果（correct）只在此响应里；宿主面板以它为准更新完成态——demo 内的本地对错反馈不算数。
 */
scenarioRouter.post('/report', (req: Request, res: Response) => {
  const { demoId, taskId, observed } = req.body as { demoId?: unknown; taskId?: unknown; observed?: unknown };
  if (typeof demoId !== 'string' || !demoId || typeof taskId !== 'string' || !taskId) {
    res.status(400).json({ error: 'demoId/taskId 必填' });
    return;
  }
  const r = reportScenario(demoId, taskId, observed, ownerIdOf(req));
  if (!r.ok) {
    res.status(404).json({ error: r.reason === 'no-task' ? '评分点不存在（不在该套题的白名单内）' : '情景题不存在' });
    return;
  }
  res.json({ ok: true, correct: r.correct ?? false, taskIndex: r.taskIndex ?? -1 });
});
