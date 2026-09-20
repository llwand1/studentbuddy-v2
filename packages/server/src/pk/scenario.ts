/**
 * pk/scenario — 情景题进对战（契约 docs/PK-SPEC.md §15.4，B4，2026-09-20）。
 *
 * D3 拍板「**整页算一题**」：一套 demo + N 个评分点，评分点**全中** +2、**有错**（含未上报）−1
 * ——与既有「一道题」同口径，不新增计分档位。独立成文件的原因同 quiz-terms.ts：
 * match.ts 已贴 400 行门禁；情景题的生成/判分/出页自成一段。
 *
 * ★ **不落 quiz_bank**：与学习侧 `saveScenario` 的关键差异。对战情景题的 criteria 与 demo
 *   源码全在**房间内存**（`PkRoomQuestion.scenarioInternal`），对局回收即消失——题库不给
 *   一局对战塞一堆一次性 demo；「criteria 永不下发」也因此结构性地成立（快照映射收口在
 *   snapshot.ts 一处，本文件的私有字段出不了服务端）。
 * ★ 通道零新造：SCENARIO_PROTOCOL 生成、SCENARIO_BRIDGE_JS 桥接、judgeTask 判分全部沿用
 *   shared/scenario.ts 与 learning/scenario.ts 既有实现（契约 §15.4「通道」行）。
 * ★ 本文件 import room/snapshot/learning，**不 import match**（match 反向 import 本文件，
 *   不造循环依赖——quiz-terms.ts 的前车之鉴）。
 */
import { randomUUID } from 'node:crypto';
import {
  ANSWER_TIME_MS,
  MAX_DOC_CHARS,
  SCENARIO_BRIDGE_JS,
  judgeTask,
  pkChannel,
  type PkRoomError,
  type ScenarioPayload,
} from '@sb/shared';
import { publish } from '../chat/sse-bus.js';
import { assembleScenarioPrompt, streamScenarioDraft } from '../learning/scenario.js';
import { SCENARIO_PROTOCOL, emptyScenarioGenReport } from '../learning/scenario-protocol.js';
import {
  requireRoomInternal,
  type PkRoomQuestion,
  type Room,
} from './room.js';
import { snapshotQuestion, snapshotRoom } from './snapshot.js';

/** 与 match.ts 同形状的域错误：message 是错误码（路由层据此查状态码） */
function fail(code: PkRoomError): never {
  throw new Error(code);
}

function memberOf(room: Room, userId: string) {
  return room.players.find((p) => p.userId === userId);
}

function broadcastState(room: Room): void {
  publish(pkChannel(room.roomId), { type: 'pk-state', roomId: room.roomId, state: snapshotRoom(room) });
}

/** 生成引擎产出的未落库草稿（payload 已过 normalize 闸门，tasks ≥ 1） */
export interface PkScenarioDraft {
  payload: ScenarioPayload;
  html: string;
}

/**
 * AI 生成一套对战情景题：复用学习侧生成引擎（同一协议 / 解析救援阶梯 / normalize 闸门），
 * 但**不落库**——返回草稿，入房由 `pushGeneratedScenario` 承接。没配模型或解析失败 → null
 * （调用方按既有 AI_GENERATION_FAILED 口径处理：回滚 CD、免费重试）。
 * 出题约束与客观题同一形状（主题 + 词条硬约束塞进提示词，跑题裁判在 match 层兜底）。
 */
export async function generatePkScenario(
  topic: string,
  prompt: string,
  termConstraint: string,
  termMaterial: string | undefined,
  ownerId: string | null,
): Promise<PkScenarioDraft | null> {
  const ask = `${prompt}\n（硬约束：题目必须严格围绕主题「${topic}」${termConstraint}，不得跑题）`;
  // 材料在场的场景不能丢「主题」行——学习侧 assembleScenarioPrompt 的二选一形状会把
  // 硬约束整句吞掉，所以对战侧自带装配（主题恒在、材料追加其后）
  const full = termMaterial
    ? `${SCENARIO_PROTOCOL}\n\n主题：${ask}\n\n材料：\n${termMaterial.slice(0, MAX_DOC_CHARS)}`
    : assembleScenarioPrompt(ask);
  return streamScenarioDraft(full, emptyScenarioGenReport(), ownerId);
}

/** 裁判跑题判定用的「题面」：demo 标题 + 各评分点任务（情景题没有单句题干） */
export function scenarioFitText(draft: PkScenarioDraft): string {
  return `${draft.payload.title}：${draft.payload.tasks.map((t) => t.prompt).join('；')}`;
}

/**
 * 把一套已生成的情景题写进对局并给出题人 +1（与 pushGeneratedQuestion 同一写入口约定：
 * AI 出题不是另一套计分）。调用方保证 draft 已过闸门；恒成功（返回 true 与客观题对称）。
 */
export function pushGeneratedScenario(
  room: Room,
  fromUserId: string,
  toUserId: string,
  prompt: string,
  draft: PkScenarioDraft,
  now: number,
  topic?: string,
): boolean {
  const question: PkRoomQuestion = {
    id: `pq-${room.roomId}-${room.questions.length + 1}`,
    roomId: room.roomId,
    fromUserId,
    toUserId,
    prompt,
    stem: draft.payload.title,
    options: [],
    createdAt: now,
    deadlineAt: now + ANSWER_TIME_MS,
    status: 'pending',
    kind: 'scenario',
    scenarioInternal: { demoId: `sd-${randomUUID()}`, tasks: draft.payload.tasks, html: draft.html },
    ...(topic ? { topic } : {}),
  };
  room.questions.push(question);
  const author = memberOf(room, fromUserId);
  if (author) author.score += 1;
  room.lastActivity = now;
  publish(pkChannel(room.roomId), { type: 'pk-question', roomId: room.roomId, question: snapshotQuestion(question) });
  broadcastState(room);
  return true;
}

/**
 * 回传一个评分点的「发生了什么」：白名单（taskId 必须在该题 tasks 里）→ judgeTask 服务端判分
 * → taskResults 记最新（demo 允许改正重报，到点前以最后一次为准）→ 广播进度。
 * ★ 判分结果只回给上报者响应；双方都能从快照看到 taskResults——那是「已判定」的公开事实，
 *   与 answerRevealed「判定后才下发」同一条纪律。
 * ★ 全中即提前结算（此后不可能更好，罚站等 45s 只会拖节奏）；有错不结算——还能改，到点才定账。
 */
export function reportScenarioTask(
  roomId: string,
  userId: string,
  rawQuestionId: unknown,
  rawTaskId: unknown,
  observed: unknown,
  now = Date.now(),
): { correct: boolean } {
  const room = requireRoomInternal(roomId);
  if (room.status !== 'active') fail('ROOM_NOT_ACTIVE');
  if (!memberOf(room, userId)) fail('NOT_A_PLAYER');
  const q = room.questions.find((x) => x.id === rawQuestionId);
  if (!q) fail('QUESTION_NOT_FOUND');
  if (q.toUserId !== userId) fail('QUESTION_NOT_YOURS');
  if (q.status !== 'pending' || now >= q.deadlineAt) fail('QUESTION_DONE');
  if (q.kind !== 'scenario' || !q.scenarioInternal) fail('QUESTION_NOT_FOUND');
  const taskId = typeof rawTaskId === 'string' ? rawTaskId : '';
  const task = q.scenarioInternal.tasks.find((t) => t.id === taskId);
  if (!task) fail('SCENARIO_TASK_INVALID');
  const correct = judgeTask(task.criteria, observed);
  if (!q.taskResults) q.taskResults = {};
  q.taskResults[taskId] = correct;
  room.lastActivity = now;
  const allHit = q.scenarioInternal.tasks.every((t) => q.taskResults?.[t.id] === true);
  if (allHit) settleScenario(room, q, now, 'answered');
  else broadcastState(room);
  return { correct };
}

/**
 * 结算情景题（D3）：评分点全中 +2 / 有错（含未上报）−1；correct/answered 计数与客观题同列。
 * `status` 区分到点结算（timeout）与全中提前结算（answered）——回看文案据此分「玩完了」与「没玩完」。
 */
export function settleScenario(room: Room, q: PkRoomQuestion, now: number, status: 'answered' | 'timeout'): void {
  const internal = q.scenarioInternal;
  const allHit = !!internal && internal.tasks.every((t) => q.taskResults?.[t.id] === true);
  const delta = allHit ? 2 : -1;
  q.status = status;
  const answerer = memberOf(room, q.toUserId);
  if (answerer) {
    answerer.score += delta;
    if (allHit) answerer.correct += 1;
    answerer.answered += 1;
    publish(pkChannel(room.roomId), {
      type: 'pk-verdict',
      roomId: room.roomId,
      questionId: q.id,
      byUserId: q.toUserId,
      correct: allHit,
      delta,
      score: answerer.score,
    });
  }
  room.lastActivity = now;
  broadcastState(room);
}

/** ticker 到点整页结算（§15.4 机制表「答题超时」行：未上报的评分点算错 ⇒ 有错 ⇒ −1） */
export function settleScenarioDue(room: Room, q: PkRoomQuestion, now: number): void {
  settleScenario(room, q, now, 'timeout');
}

/**
 * 出 demo 页（宿主 iframe 用）：桥接脚本前置注入（同 learning/scenario.buildScenarioDemoPage），
 * 换成房间内存取源 + **房内成员校验**——demo 的授权是「对局双方」，不是 quiz_bank 的 owner。
 * 非成员 / 房不存在 / demoId 查无 → null（路由 404）。
 */
export function pkScenarioPage(roomId: string, userId: string, demoId: string): string | null {
  const room = requireRoomInternal(roomId);
  if (!room.players.some((p) => p.userId === userId)) return null;
  const q = room.questions.find((x) => x.kind === 'scenario' && x.scenarioInternal?.demoId === demoId);
  const internal = q?.scenarioInternal;
  if (!internal) return null;
  const bridge = `<script>${SCENARIO_BRIDGE_JS.replace('__SB_DEMO_ID__', internal.demoId)}</script>`;
  return bridge + internal.html;
}
