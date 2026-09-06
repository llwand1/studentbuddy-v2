/**
 * storage/obs — 可观测地基：事件落库与只读查询（可观测与数据飞轮方案 §2.3，2026-09-06）。
 *
 * 定位：events/bus 的订阅消费端。发布方（flow / quiz / search / 点踩）只管 publishEvent，
 * 对观测零感知（ADR-3 域自治）；订阅者抛错由 bus.ts 的 ADR-4 兜底（只记日志、不阻塞发布方），
 * 故本文件不再自行 try/catch，避免双份口径。
 * 配套迁移：db.ts v9（v8 已被认知进化契约预留）。
 */
import { getDb } from './db.js';
import { subscribeEvents } from '../events/bus.js';
import { isObsKind } from '@sb/shared/obs';
import type { ObsEventBody, ObsEventRow, ObsKind, ObsPayload } from '@sb/shared/obs';

type ObsInput = Pick<ObsEventBody, 'kind' | 'sessionId' | 'payload' | 'latencyMs' | 'tokensIn' | 'tokensOut'>;

/** 落库一行观测事件，返回自增 id。payload 序列化为 JSON 字符串存储（只存摘要类字段）。 */
export function recordObsEvent(ev: ObsInput): number {
  const info = getDb()
    .prepare(
      'INSERT INTO event_log (session_id, kind, payload, latency_ms, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      ev.sessionId ?? null,
      ev.kind,
      ev.payload ? JSON.stringify(ev.payload) : null,
      ev.latencyMs ?? null,
      ev.tokensIn ?? null,
      ev.tokensOut ?? null,
    );
  return Number(info.lastInsertRowid);
}

function parsePayload(s: string | null): ObsPayload | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as ObsPayload;
  } catch {
    return null; // 单行脏 JSON 只降级该行，不炸整个查询（数据容错）
  }
}

/** 只读查询：kind 精确过滤、sinceId 增量拉取、limit 钳制 1..200（默认 50），按 id 倒序。 */
export function listObsEvents(opts: { kind?: ObsKind; sinceId?: number; limit?: number } = {}): ObsEventRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const conds: string[] = [];
  const args: Array<string | number> = [];
  if (opts.kind) {
    conds.push('kind = ?');
    args.push(opts.kind);
  }
  if (opts.sinceId !== undefined) {
    conds.push('id > ?');
    args.push(opts.sinceId);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(
      `SELECT id, ts, session_id AS sessionId, kind, payload,
              latency_ms AS latencyMs, tokens_in AS tokensIn, tokens_out AS tokensOut
       FROM event_log ${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(...args, limit) as Array<{
    id: number;
    ts: string;
    sessionId: string | null;
    kind: string;
    payload: string | null;
    latencyMs: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
  }>;
  return rows.flatMap((r) => {
    if (!isObsKind(r.kind)) return []; // 防御：库内 kind 恒由本模块写入，此处只做类型收窄
    const row: ObsEventRow = {
      id: r.id,
      ts: r.ts,
      sessionId: r.sessionId,
      kind: r.kind,
      payload: parsePayload(r.payload),
      latencyMs: r.latencyMs,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
    };
    return [row];
  });
}

/** 启动时注册事件订阅（幂等：模块单例，同 wireActivityEvents 套路）。 */
let wired = false;
export function wireObsEvents(): void {
  if (wired) return;
  wired = true;
  subscribeEvents((ev) => {
    if (ev.type === 'obs' && isObsKind(ev.kind)) recordObsEvent(ev);
  });
}
