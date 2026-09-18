/**
 * learning/scenario — 情景题域（契约 docs/SCENARIO-SPEC.md v1.0，2026-09-17 新建）。
 *
 * 职责三件：① saveScenario（quiz_bank + scenario_demo 双写，M1 由 /seed 调，M2 起是出题引擎的落点）；
 * ② buildScenarioDemoPage（出页 + 桥接注入——demoId 占位符在这里替换）；③ reportScenario（回传白名单
 * + judgeTask 服务端判分 + recordAnswer 记账——**每个评分点在 quiz_stats 里就是一道普通题**，契约 §0.1）。
 *
 * ★ 裁判在服务端（契约 §0.2）：demo 只上报事实（observed），对错由本域 judgeTask 判——demo 是模型写的
 *   不可信侧，它判错了数据就永久错且无法复查。
 * ★ 白名单两道：宿主一道（web 侧 validateScenarioReport），本域一道（taskId 必须在套题 tasks 里）。
 *   双白名单不是重复防御：宿主在客户端可被绕过的前提假定下，服务端这道才是闸门。
 */
import { randomUUID } from 'node:crypto';
import type { ScenarioPayload, ScenarioTask } from '@sb/shared';
import {
  MAX_DOC_CHARS,
  MAX_SCENARIO_HTML_CHARS,
  SCENARIO_BRIDGE_JS,
  SCENARIO_SOURCE,
  judgeTask,
  normalizeScenarioPayload,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { recordAnswer } from './quiz.js';
import { publish } from '../chat/sse-bus.js';
import { routeRole } from '../llm/router.js';
import { QUIZ_TEMPERATURE, getQuizMaxOutputTokens } from '../llm/model-limits.js';
import { emptyScenarioGenReport, parseScenarioBlock, SCENARIO_PROTOCOL, type ScenarioGenReport } from './scenario-protocol.js';

/** reportScenario 的失败真因（ADR-5 谁真知道谁填，路由只映射状态码不反推） */
export type ScenarioReportFailure = 'no-demo' | 'no-task';

export interface ScenarioReportResult {
  ok: boolean;
  reason?: ScenarioReportFailure;
  correct?: boolean;
  taskIndex?: number;
}

/**
 * 登记一套情景题：normalize 评分点 → quiz_bank（source='scenario'）+ scenario_demo 双写。
 * 入参整体 unknown——信任边界在域层不在路由（/seed 的 body 与 M2 的模型输出走同一个闸门）。
 * 非法输入返回 null（路由 400），**绝不部分落库**：先 normalize 全过再开写。
 */
export function saveScenario(input: unknown, html: unknown): { quizId: string; demoId: string } | null {
  const payload = normalizeScenarioPayload(input);
  if (!payload) return null;
  if (typeof html !== 'string' || !html.trim() || html.length > MAX_SCENARIO_HTML_CHARS) return null;
  const db = getDb();
  const quizId = randomUUID();
  const demoId = randomUUID();
  const write = db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO quiz_bank (id, title, source, data) VALUES (?, ?, ?, ?)').run(
      quizId,
      payload.title,
      SCENARIO_SOURCE,
      JSON.stringify(payload),
    );
    db.prepare('INSERT INTO scenario_demo (id, quiz_id, html) VALUES (?, ?, ?)').run(demoId, quizId, html);
  });
  write();
  return { quizId, demoId };
}

/** 读一套情景题的评分点（题库 JSON 解析失败返回 null，数据容错 ADR-6） */
export function getScenario(quizId: string): ScenarioPayload | null {
  const row = getDb().prepare('SELECT data FROM quiz_bank WHERE id = ?').get(quizId) as
    | { data: string }
    | undefined;
  if (!row) return null;
  try {
    return normalizeScenarioPayload(JSON.parse(row.data) as unknown);
  } catch {
    return null;
  }
}

/** 由套题反查 demoId（题库 JSON 不存 demoId，1:1 关系在本表） */
export function getScenarioDemoId(quizId: string): string | null {
  const row = getDb().prepare('SELECT id FROM scenario_demo WHERE quiz_id = ?').get(quizId) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/**
 * 出 demo 页：桥接脚本**前置注入**（demo 的脚本都晚于它执行，SBScenario 必然先就位；
 * 不挑 `<head>` 插入点是因为模型给的 html 可能是片段，没有 head 可挑）。
 * demoId 占位符替换后即回源码；找不到 demo 返回 null（路由 404）。
 */
export function buildScenarioDemoPage(demoId: string): string | null {
  const row = getDb().prepare('SELECT html FROM scenario_demo WHERE id = ?').get(demoId) as
    | { html: string }
    | undefined;
  if (!row) return null;
  const bridge = `<script>${SCENARIO_BRIDGE_JS.replace('__SB_DEMO_ID__', demoId)}</script>`;
  return bridge + row.html;
}

/**
 * 回传判分：demoId → 套题 → taskId 白名单（第二道，契约 §2）→ judgeTask → recordAnswer。
 * 判分与记账同事务语义上必须一致：recordAnswer 内部自带 upsert，判完即记，失败抛错由路由兜。
 * observed 原样进 judgeTask、**不落库原文**（M1 边界，契约 §9）。
 */
export function reportScenario(demoId: string, taskId: string, observed: unknown): ScenarioReportResult {
  const db = getDb();
  const demo = db.prepare('SELECT quiz_id FROM scenario_demo WHERE id = ?').get(demoId) as
    | { quiz_id: string }
    | undefined;
  if (!demo) return { ok: false, reason: 'no-demo' };
  const payload = getScenario(demo.quiz_id);
  if (!payload) return { ok: false, reason: 'no-demo' };
  const taskIndex = payload.tasks.findIndex((t: ScenarioTask) => t.id === taskId);
  if (taskIndex < 0) return { ok: false, reason: 'no-task' };
  const task = payload.tasks[taskIndex];
  if (!task) return { ok: false, reason: 'no-task' };
  const correct = judgeTask(task.criteria, observed);
  recordAnswer(demo.quiz_id, taskIndex, correct);
  return { ok: true, correct, taskIndex };
}

/** 删套题时连带删 demo 行（quiz.ts deleteQuiz 调；无行删零行，幂等） */
export function deleteScenarioDemoByQuiz(quizId: string): void {
  getDb().prepare('DELETE FROM scenario_demo WHERE quiz_id = ?').run(quizId);
}

/**
 * 把生成好的一套情景题推进某个会话的聊天流（M3 引入、M4 编排执行器复用——
 * REST 路由与 study-flow 执行器是仅有的两个出题入口，下发逻辑必须同一份，不许双写漂移）：
 * ① SSE `block` 事件（blockId=`scenario-<demoId>`，前端 live 出卡片）；
 * ② messages 历史落库：`[SCENARIO]{payload 顶层 + quizId/demoId 登记键}[/SCENARIO]`
 *    （登记键只进聊天消息 content，quiz_bank data 保持纯契约形状）。
 * publish 无订阅者时是安全空转（学习流执行器在后台跑时用户可能没开这个会话页，
 * 历史落库保证重开能看到），所以这里不关心订阅状态。
 */
export function announceScenarioToSession(sessionId: string, gen: ScenarioGenerated): void {
  // publish 无订阅者时是安全空转（见上），所以这里不关心订阅状态、同步发完即落库
  publish(sessionId, {
      type: 'block',
      sessionId,
      blockId: `scenario-${gen.demoId}`,
      done: true,
      payload: { kind: 'scenario', blockId: `scenario-${gen.demoId}`, payload: gen.payload },
    } satisfies Parameters<typeof publish>[1]);
  getDb()
    .prepare(`INSERT INTO messages (id, session_id, role, content, tokens) VALUES (?, ?, 'assistant', ?, ?)`)
    .run(
      `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      `[SCENARIO]${JSON.stringify({ ...gen.payload, quizId: gen.quizId, demoId: gen.demoId })}[/SCENARIO]`,
      0,
    );
}

// ── 出题引擎（M2，契约 §6）──

export interface ScenarioGenerated {
  quizId: string;
  demoId: string;
  payload: ScenarioPayload;
}

/**
 * AI 生成一套情景题（契约 §6：SCENARIO_PROTOCOL 双标记 → 解析救援阶梯 → saveScenario 入库）。
 * 与 generateQuiz 同一条引擎装配线：quiz-generator 角色模型、同温度（题目要稳）、同输出上限
 * （demo 体量大，通用表更会撞）。失败真因写 report（no-model / parse），路由只映射状态码不反推。
 */
export async function generateScenario(
  topic: string,
  material?: string,
  report: ScenarioGenReport = emptyScenarioGenReport(),
  ownerId?: string | null, // M2c 归属（契约 TENANCY-SPEC §8.1.4）
): Promise<ScenarioGenerated | null> {
  const target = routeRole('quiz-generator', undefined, ownerId);
  if (!target || !target.model) {
    report.failure = 'no-model';
    return null;
  }
  const prompt = `${SCENARIO_PROTOCOL}\n\n${material ? `材料：\n${material.slice(0, MAX_DOC_CHARS)}` : `主题：${topic}`}`;
  let acc = '';
  for await (const chunk of target.adapter.chat({
    model: target.model,
    apiKey: target.apiKey,
    baseUrl: target.baseUrl,
    messages: [{ role: 'user', content: prompt }],
    temperature: QUIZ_TEMPERATURE,
    maxTokens: getQuizMaxOutputTokens(target.model),
  })) {
    acc += chunk.content;
    if (chunk.done) {
      // 适配器的权威截断信号（与 generateQuiz 同口径，不靠猜输出形状）
      if (chunk.finishReason === 'length') report.truncated = true;
      break;
    }
  }
  const parsed = parseScenarioBlock(acc, report);
  if (!parsed) {
    report.failure = 'parse';
    return null;
  }
  const saved = saveScenario(parsed.payload, parsed.html);
  // parseScenarioBlock 已过同一 normalize 闸门，这里失败只剩竞态/IO，如实归入 parse 报给路由
  if (!saved) {
    report.failure = 'parse';
    return null;
  }
  return { ...saved, payload: parsed.payload };
}
