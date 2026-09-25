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
import { ownerForWrite } from '../auth/ownership.js';
import { recordAnswer } from './quiz.js';
import { publish } from '../chat/sse-bus.js';
import { routeRole } from '../llm/router.js';
import { QUIZ_TEMPERATURE, getQuizMaxOutputTokens } from '../llm/model-limits.js';
import { parseScenarioBlock, SCENARIO_PROTOCOL, type ScenarioGenReport } from './scenario-protocol.js';

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
export function saveScenario(input: unknown, html: unknown, ownerId: string | null): { quizId: string; demoId: string } | null {
  const payload = normalizeScenarioPayload(input);
  if (!payload) return null;
  if (typeof html !== 'string' || !html.trim() || html.length > MAX_SCENARIO_HTML_CHARS) return null;
  const db = getDb();
  const quizId = randomUUID();
  const demoId = randomUUID();
  const write = db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO quiz_bank (id, title, source, data, owner_id) VALUES (?, ?, ?, ?, ?)').run(
      quizId,
      payload.title,
      SCENARIO_SOURCE,
      JSON.stringify(payload),
      ownerForWrite(ownerId),
    );
    db.prepare('INSERT INTO scenario_demo (id, quiz_id, html) VALUES (?, ?, ?)').run(demoId, quizId, html);
  });
  write();
  return { quizId, demoId };
}

/** 读一套情景题的评分点（题库 JSON 解析失败或不是你的返回 null，数据容错 ADR-6） */
export function getScenario(quizId: string, ownerId: string | null): ScenarioPayload | null {
  const row = getDb()
    .prepare('SELECT data FROM quiz_bank WHERE id = ? AND owner_id = ?')
    .get(quizId, ownerForWrite(ownerId)) as
    | { data: string }
    | undefined;
  if (!row) return null;
  try {
    return normalizeScenarioPayload(JSON.parse(row.data) as unknown);
  } catch {
    return null;
  }
}

/**
 * 由套题反查 demoId（题库 JSON 不存 demoId，1:1 关系在本表）。
 * ★ 归属靠 JOIN 回 quiz_bank 判（demo 表自己没有 owner 列，正是本批泄露的根因）；别人的套题 → null。
 */
export function getScenarioDemoId(quizId: string, ownerId: string | null): string | null {
  const row = getDb()
    .prepare('SELECT d.id FROM scenario_demo d JOIN quiz_bank q ON q.id = d.quiz_id WHERE d.quiz_id = ? AND q.owner_id = ?')
    .get(quizId, ownerForWrite(ownerId)) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * 出 demo 页：桥接脚本**前置注入**（demo 的脚本都晚于它执行，SBScenario 必然先就位；
 * 不挑 `<head>` 插入点是因为模型给的 html 可能是片段，没有 head 可挑）。
 * demoId 占位符替换后即回源码；找不到 demo 返回 null（路由 404）。
 */
export function buildScenarioDemoPage(demoId: string, ownerId: string | null): string | null {
  // 归属同 getScenarioDemoId（JOIN quiz_bank）：demo 页由宿主面板的 iframe 加载，
  // 同站请求带 httpOnly cookie ⇒ 云模式下这里的 ownerIdOf(req) 拿得到人，面板链路不受影响。
  const row = getDb()
    .prepare('SELECT d.html FROM scenario_demo d JOIN quiz_bank q ON q.id = d.quiz_id WHERE d.id = ? AND q.owner_id = ?')
    .get(demoId, ownerForWrite(ownerId)) as { html: string } | undefined;
  if (!row) return null;
  const bridge = `<script>${SCENARIO_BRIDGE_JS.replace('__SB_DEMO_ID__', demoId)}</script>`;
  return bridge + row.html;
}

/**
 * 回传判分：demoId → 套题 → taskId 白名单（第二道，契约 §2）→ judgeTask → recordAnswer。
 * 判分与记账同事务语义上必须一致：recordAnswer 内部自带 upsert，判完即记，失败抛错由路由兜。
 * observed 原样进 judgeTask、**不落库原文**（M1 边界，契约 §9）。
 */
export function reportScenario(demoId: string, taskId: string, observed: unknown, ownerId: string | null): ScenarioReportResult {
  const db = getDb();
  const demo = db.prepare('SELECT quiz_id FROM scenario_demo WHERE id = ?').get(demoId) as
    | { quiz_id: string }
    | undefined;
  if (!demo) return { ok: false, reason: 'no-demo' };
  const payload = getScenario(demo.quiz_id, ownerId);
  if (!payload) return { ok: false, reason: 'no-demo' };
  const taskIndex = payload.tasks.findIndex((t: ScenarioTask) => t.id === taskId);
  if (taskIndex < 0) return { ok: false, reason: 'no-task' };
  const task = payload.tasks[taskIndex];
  if (!task) return { ok: false, reason: 'no-task' };
  const correct = judgeTask(task.criteria, observed);
  recordAnswer(demo.quiz_id, taskIndex, correct, ownerId);
  return { ok: true, correct, taskIndex };
}

/**
 * 删套题时连带删 demo 行（routes/quiz.ts 调；无行删零行，幂等）。
 * ★ 归属经子查询回 quiz_bank 判（2026-09-21 闸门 #2）：B 删不动 A 的套题行，但此前能删掉 A 的
 *   demo 行——响应恒 {ok:true} 证不了，表现为「套题还在、情景题突然不可玩」。
 * ★ 调用点必须在 `deleteQuiz` **之前**：bank 行一删，这条子查询就判不出归属（本来该删的也删不掉）。
 */
export function deleteScenarioDemoByQuiz(quizId: string, ownerId: string | null): void {
  getDb()
    .prepare('DELETE FROM scenario_demo WHERE quiz_id IN (SELECT id FROM quiz_bank WHERE id = ? AND owner_id = ?)')
    .run(quizId, ownerForWrite(ownerId));
}

/**
 * 把生成好的一套情景题推进某个会话的聊天流（M3 引入；REST 路由是唯一的出题入口——
 * 学习流执行器入口 2026-09-25 随功能下线拆除，批次 K）：
 * ① SSE `block` 事件（blockId=`scenario-<demoId>`，前端 live 出卡片）；
 * ② messages 历史落库：`[SCENARIO]{payload 顶层 + quizId/demoId 登记键}[/SCENARIO]`
 *    （登记键只进聊天消息 content，quiz_bank data 保持纯契约形状）。
 * publish 无订阅者时是安全空转（用户可能没开这个会话页，
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
 * 装配出题提示词（契约 §6 的固定形状：协议在前，材料/主题二选一在后）。
 * ★ 独立成函数：PK 对战（pk/scenario.ts）复用同一引擎但要拼自己的约束入参——
 *   装配与调用分开，学习侧的字节形状才不会被对战侧的改动牵连。
 */
export function assembleScenarioPrompt(topic: string, material?: string): string {
  return `${SCENARIO_PROTOCOL}\n\n${material ? `材料：\n${material.slice(0, MAX_DOC_CHARS)}` : `主题：${topic}`}`;
}

/**
 * 跑一遍情景题生成引擎（模型流式 → 双标记解析救援阶梯），返回**未落库**的草稿。
 * ★ PK 对战走本函数（§15.4：对战情景题不落 quiz_bank——criteria 与 demo 全在房间内存，
 *   对局回收即消失，不给题库塞垃圾）；学习侧的 `generateScenario` ＝ 本函数 + saveScenario。
 * 失败真因写 report（no-model / parse），调用方只管映射状态码。
 */
export async function streamScenarioDraft(
  prompt: string,
  report: ScenarioGenReport,
  ownerId: string | null,
): Promise<{ payload: ScenarioPayload; html: string } | null> {
  const target = routeRole('quiz-generator', undefined, ownerId);
  if (!target || !target.model) {
    report.failure = 'no-model';
    return null;
  }
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
  return parsed;
}

/**
 * AI 生成一套情景题（契约 §6：SCENARIO_PROTOCOL 双标记 → 解析救援阶梯 → saveScenario 入库）。
 * 与 generateQuiz 同一条引擎装配线：quiz-generator 角色模型、同温度（题目要稳）、同输出上限
 * （demo 体量大，通用表更会撞）。失败真因写 report（no-model / parse），路由只映射状态码不反推。
 */
export async function generateScenario(
  topic: string,
  material: string | undefined,
  report: ScenarioGenReport,
  ownerId: string | null, // M2c 归属（契约 TENANCY-SPEC §8.1.4）；M2d-3 起必填——saveScenario 要落 owner_id
): Promise<ScenarioGenerated | null> {
  const prompt = assembleScenarioPrompt(topic, material);
  const parsed = await streamScenarioDraft(prompt, report, ownerId);
  if (!parsed) return null;
  const saved = saveScenario(parsed.payload, parsed.html, ownerId);
  // parseScenarioBlock 已过同一 normalize 闸门，这里失败只剩竞态/IO，如实归入 parse 报给路由
  if (!saved) {
    report.failure = 'parse';
    return null;
  }
  return { ...saved, payload: parsed.payload };
}
