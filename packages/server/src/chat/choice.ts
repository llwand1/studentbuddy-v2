/**
 * chat/choice — 「方案选择框」服务端核心（契约 docs/ASK-CHOICE-SPEC.md）。
 *
 * 职责边界：校验归一 + 落库 + SSE 下发 + **把一个提问变成可 await 的 Promise**。
 * 不碰 LLM、不碰前端渲染（薄层原则 ADR-3 的服务端半边）。
 *
 * 为什么不需要内部端点与轮询（与 ai-orchestrator-v2 的关键差异）：
 * 那边的工具跑在 opencode 内核进程里、与编排层跨进程，只能靠 HTTP 轮询等答复；
 * 本仓 `ask_choice` 工具与用户答复在**同一个 Node 进程**内，一个 resolver Map 就能完成
 * 「工具挂起 → 用户点选 → 同轮继续」，少两条端点、少一圈轮询延迟。
 *
 * 超时语义（老板拍板，与 orchestrator 一致）：**不设自动超时**，挂起的 Promise 一直等。
 * 代价是会占住会话（flow.ts 的同会话串行锁），故逃生口只能走「事后可恢复」而非事前拦截：
 *   ① 停止生成 → flow.ts 的 abort 分支调 cancelChoicesBySession
 *   ② 删会话   → routes 的 DELETE /sessions/:id 调 cancelChoicesBySession
 *   ③ 进程重启 → index.ts 启动时 sweepStaleChoices（内存 Promise 已随进程消失，
 *      库里遗留的 pending 永远等不到答复，不清就会让前端捞出一张点不动的死卡）
 */
import { randomUUID } from 'node:crypto';
import { describeChoiceReply, normalizeChoiceInput, normalizeChoiceReply } from '@sb/shared';
import type { AskChoiceRecord, AskChoiceReply, ChoiceOption, ChoiceStatus } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { publish } from './sse-bus.js';

// ── 存储层（ask_choices 表读写；全部 SQL 集中在此，别处不再写一份）──

interface AskRow {
  id: string;
  session_id: string;
  question: string;
  options_json: string;
  allow_custom: number;
  multi: number;
  status: string;
  reply_option_id: string | null;
  reply_custom: string | null;
  reply_ts: number | null;
  cancel_reason: string | null;
  answered_at: string | null;
  created_at: string;
}

/** SQLite `datetime('now')`（UTC `YYYY-MM-DD HH:MM:SS`）→ epoch ms；解析失败回落 0 */
const utcMs = (s: string | null): number => (s ? Date.parse(`${s.replace(' ', 'T')}Z`) || 0 : 0);

function toRecord(r: AskRow): AskChoiceRecord {
  const reply: AskChoiceReply | null =
    r.status === 'answered' && r.reply_ts !== null
      ? {
          requestId: r.id,
          optionId: r.reply_option_id,
          ...(r.reply_custom ? { custom: r.reply_custom } : {}),
          ts: r.reply_ts,
        }
      : null;
  return {
    id: r.id,
    sessionId: r.session_id,
    question: r.question,
    options: JSON.parse(r.options_json) as ChoiceOption[],
    allowCustom: r.allow_custom === 1,
    multi: r.multi === 1,
    ts: utcMs(r.created_at),
    status: r.status as ChoiceStatus,
    reply,
    answeredAt: r.answered_at ? utcMs(r.answered_at) : null,
    ...(r.cancel_reason ? { cancelReason: r.cancel_reason } : {}),
  };
}

function insertAsk(rec: AskChoiceRecord): void {
  getDb()
    .prepare(
      `INSERT INTO ask_choices (id, session_id, question, options_json, allow_custom, multi, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(rec.id, rec.sessionId, rec.question, JSON.stringify(rec.options), rec.allowCustom ? 1 : 0, rec.multi ? 1 : 0);
}

const selectRow = (id: string): AskRow | undefined =>
  getDb().prepare('SELECT * FROM ask_choices WHERE id = ?').get(id) as AskRow | undefined;

/**
 * 条件更新为已答复：`WHERE status='pending'` 是并发双端点击的唯一裁决——
 * 第二只手点下去时 changes=0，调用方据此回 409，**不覆盖首答**（与 orchestrator 同口径）。
 */
function markAnswered(id: string, optionId: string | null, custom: string | null, ts: number): boolean {
  const r = getDb()
    .prepare(
      `UPDATE ask_choices SET status='answered', reply_option_id=?, reply_custom=?, reply_ts=?,
       answered_at=datetime('now') WHERE id=? AND status='pending'`,
    )
    .run(optionId, custom, ts, id);
  return r.changes === 1;
}

function markCancelled(id: string, reason: string): boolean {
  const r = getDb()
    .prepare(`UPDATE ask_choices SET status='cancelled', cancel_reason=? WHERE id=? AND status='pending'`)
    .run(reason, id);
  return r.changes === 1;
}

/**
 * 把「已成功作废」的行整理成 cancelled 快照。
 * ★ 必须就地改 status：`SELECT` 拿到的是改库**之前**的内存快照（status 仍是 'pending'），
 *   不回填的话下游 toRecord 会造出一份 status='pending' 的记录，waiter 唤醒后拿到的状态是错的。
 */
const asCancelled = (rows: AskRow[], reason: string): AskRow[] =>
  rows.map((row) => ({ ...row, status: 'cancelled', cancel_reason: reason }));

/** 取某会话全部挂起项并逐条作废，返回**已作废**的行（拿不到说明它已被答复，不该广播 cancelled） */
function cancelPendingOfSession(sessionId: string, reason: string): AskRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM ask_choices WHERE session_id = ? AND status = 'pending'`)
    .all(sessionId) as AskRow[];
  return asCancelled(
    rows.filter((row) => markCancelled(row.id, reason)),
    reason,
  );
}

/** 全库挂起项标记作废并返回被作废的行（仅启动清理用） */
function cancelAllPending(reason: string): AskRow[] {
  const rows = getDb().prepare(`SELECT * FROM ask_choices WHERE status = 'pending'`).all() as AskRow[];
  return asCancelled(
    rows.filter((row) => markCancelled(row.id, reason)),
    reason,
  );
}

// ── 等待表（进程内）：requestId → 唤醒钩子 ──

/**
 * 挂起中的提问。**恒 resolve**（不 reject）——用户点选与作废都要让工具拿到一份权威结果再去
 * 决定怎么回灌模型；用异常表示「作废」会走 runTool 的 catch 变成「工具执行失败」，
 * 模型收到的是一句报错而不是「用户没选，请直接作答」这种可继续的指令。
 */
const waiters = new Map<string, (r: AskChoiceRecord) => void>();

export interface AskChoiceInput {
  sessionId: string;
  /** 收 unknown：非空/条数/长度校验在 shared 的纯函数里做，调用方直通即可 */
  question: unknown;
  options: unknown;
  allowCustom?: unknown;
  multi?: unknown;
}

export type AskChoiceResult = { ok: true; record: AskChoiceRecord } | { ok: false; error: string };

/**
 * 创建提问并**挂起等待**答复。校验失败立刻返回（模型可自纠）；成功则一直等到
 * answered / cancelled 才返回（用户不选就一直等，契约不设超时）。
 */
export async function askChoice(input: AskChoiceInput): Promise<AskChoiceResult> {
  const norm = normalizeChoiceInput({
    question: input.question,
    options: input.options,
    allowCustom: input.allowCustom,
    multi: input.multi,
  });
  if (!norm.ok) return { ok: false, error: norm.error };

  const id = randomUUID();
  const record: AskChoiceRecord = {
    id,
    sessionId: input.sessionId,
    question: norm.question,
    options: norm.options,
    allowCustom: norm.allowCustom,
    multi: norm.multi,
    ts: Date.now(),
    status: 'pending',
    reply: null,
    answeredAt: null,
  };
  insertAsk(record);

  // 先登记唤醒钩子再广播：用户极速点选时 answerChoice 必须找得到它（顺序颠倒＝丢一次唤醒）
  const waited = new Promise<AskChoiceRecord>((resolve) => waiters.set(id, resolve));
  publish(input.sessionId, { type: 'choice-asked', sessionId: input.sessionId, request: record });

  const settled = await waited;
  waiters.delete(id);
  return { ok: true, record: settled };
}

export type AnswerResult = { ok: true; record: AskChoiceRecord } | { ok: false; status: number; error: string };

/** 用户答复：校验归属 → 条件更新落库 → 广播 → 唤醒挂起的工具 */
export function answerChoice(id: string, raw: { optionId?: unknown; custom?: unknown }): AnswerResult {
  const row = selectRow(id);
  if (!row) return { ok: false, status: 404, error: '提问不存在' };
  if (row.status !== 'pending') {
    const state = row.status === 'answered' ? '已被答复' : '作废';
    return { ok: false, status: 409, error: `提问已${state}，不再接受答复` };
  }

  const before = toRecord(row);
  const norm = normalizeChoiceReply(raw, { options: before.options, allowCustom: before.allowCustom });
  if (!norm.ok) return { ok: false, status: 400, error: norm.error };

  const ts = Date.now();
  if (!markAnswered(id, norm.optionId, norm.custom ?? null, ts)) {
    return { ok: false, status: 409, error: '提问已被答复或作废' };
  }
  const after = toRecord(selectRow(id)!);
  publish(before.sessionId, {
    type: 'choice-replied',
    sessionId: before.sessionId,
    requestId: id,
    reply: after.reply ?? { requestId: id, optionId: norm.optionId, ts },
  });
  // 无 waiter ＝ 进程重启过或已被作废：仅落库与广播，不影响正确性（工具侧早已结算）
  waiters.get(id)?.(after);
  waiters.delete(id);
  return { ok: true, record: after };
}

/** 作废单条（逃生口）。已终结的返回 null（幂等，不炸） */
export function cancelChoice(id: string, reason: string): AskChoiceRecord | null {
  if (!markCancelled(id, reason)) return null;
  const rec = toRecord(selectRow(id)!);
  publish(rec.sessionId, { type: 'choice-cancelled', sessionId: rec.sessionId, requestId: id, reason });
  waiters.get(id)?.(rec);
  waiters.delete(id);
  return rec;
}

/** 作废某会话全部挂起提问（逃生口：停止生成 / 删会话），返回作废条数 */
export function cancelChoicesBySession(sessionId: string, reason: string): number {
  const rows = cancelPendingOfSession(sessionId, reason);
  for (const row of rows) {
    const rec = toRecord(row);
    publish(sessionId, { type: 'choice-cancelled', sessionId, requestId: rec.id, reason });
    waiters.get(rec.id)?.(rec);
    waiters.delete(rec.id);
  }
  return rows.length;
}

/** 挂起清单（前端刷新/重连后把卡片捞回来用；已终结的不返回） */
export function listPendingChoices(sessionId: string): AskChoiceRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM ask_choices WHERE session_id = ? AND status = 'pending' ORDER BY created_at, rowid`)
    .all(sessionId) as AskRow[];
  return rows.map(toRecord);
}

/**
 * 进程启动清理：内存 Promise 已随进程消失，库里 pending 永远等不到答复——统一标作废。
 * ★ 同时唤醒**本进程内**仍挂着的 waiter：真·重启场景里它本就不存在，但同一进程内被调用时
 *   （测试、或日后的管理入口）不唤醒的话那个工具会永久悬挂——恒 resolve 是零成本的保险。
 */
export function sweepStaleChoices(): number {
  const reason = '服务重启，本次提问已作废';
  const rows = cancelAllPending(reason);
  for (const row of rows) {
    const rec = toRecord(row);
    publish(rec.sessionId, { type: 'choice-cancelled', sessionId: rec.sessionId, requestId: rec.id, reason });
    waiters.get(rec.id)?.(rec);
    waiters.delete(rec.id);
  }
  return rows.length;
}

/** 工具回灌文本（与 describeChoiceReply 同源，两处措辞不各写一份） */
export function choiceToolHint(record: AskChoiceRecord): string {
  if (record.status === 'cancelled') {
    return `本次选择已作废（${record.cancelReason ?? '未知原因'}）。不要再次调用 ask_choice，请基于已有信息直接作答。`;
  }
  const reply = record.reply ?? { requestId: record.id, optionId: null, ts: 0 };
  return `${describeChoiceReply(reply, record.options)}。请直接按这个选择继续，不要重复提问同一个点。`;
}
