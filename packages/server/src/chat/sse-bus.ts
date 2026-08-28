/**
 * chat/sse-bus — SSE 广播（按 sessionId 隔离 + seq 单调去重 + since 增量回放 + 心跳）。
 * 契约：packages/shared/sse-events.ts（先登记再实现，docs/SSE-CONTRACT.md 同步）。
 * v1 教训继承：串台防护（sessionId 过滤，禁通配订阅）；断线恢复 = 客户端带 since 重连 + /live 快照。
 */
import type { Response } from 'express';
import type { SseEvent } from '@sb/shared';

/** 进缓冲/需编号的事件（ping 心跳不进缓冲、无 seq） */
type SeqEvent = Extract<SseEvent, { seq: number }>;
/** Omit 需对联合分发（否则 keyof 只剩公共键） */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type Publishable = DistributiveOmit<SeqEvent, 'seq'>;

interface Client {
  sessionId: string;
  res: Response;
  since: number;
}

interface SessionBuffer {
  events: SeqEvent[];
  /** 新一轮对话（sendText）重置为 0 */
  round: number;
}

const clients = new Set<Client>();
const buffers = new Map<string, SessionBuffer>();
const BUFFER_TTL_MS = 60_000;

function writeEvent(res: Response, ev: SseEvent): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/** 注册 SSE 连接：回放 seq > since 的缓冲事件后接入实时推送。 */
export function subscribe(sessionId: string, res: Response, since = 0): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const client: Client = { sessionId, res, since };
  clients.add(client);

  const buf = buffers.get(sessionId);
  if (buf) {
    // 回放只为恢复"进行中的一轮"；已完结的一轮已落库，正文由 /messages 权威提供。
    // 全量回放会让前端把同一答案二次上屏（真机复现），故已完结时只补 done 收尾信号。
    const doneIdx = buf.events.findIndex((e) => e.type === 'done');
    const replay = doneIdx >= 0 ? buf.events.slice(doneIdx, doneIdx + 1) : buf.events;
    for (const ev of replay) {
      if (ev.seq > since) writeEvent(res, ev);
    }
  }
  writeEvent(res, { type: 'ping' });

  const cleanup = () => {
    clients.delete(client);
  };
  res.on('close', cleanup);
  return cleanup;
}

/** 广播事件到该会话的全部连接并写入缓冲（seq 按会话独立单调递增）。 */
export function publish(sessionId: string, ev: Publishable): number {
  let buf = buffers.get(sessionId);
  if (!buf) {
    buf = { events: [], round: 0 };
    buffers.set(sessionId, buf);
  }
  const seq = buf.events.length > 0 ? (buf.events[buf.events.length - 1]?.seq ?? 0) + 1 : 1;
  const full = { ...ev, seq } as SeqEvent;
  buf.events.push(full);
  if (buf.events.length > 2000) buf.events.splice(0, buf.events.length - 2000);

  for (const c of clients) {
    if (c.sessionId === sessionId && full.seq > c.since) writeEvent(c.res, full);
  }
  return seq;
}

/** 新一轮对话开始：清空缓冲、seq 从 1 重新计数（客户端同时重置 since=0）。 */
export function startNewRound(sessionId: string): void {
  const buf = buffers.get(sessionId);
  if (buf) buf.events = [];
  for (const c of clients) if (c.sessionId === sessionId) c.since = 0;
}

/** 当前会话事件快照（/live 对齐用：返回全部缓冲事件，客户端增量补齐）。 */
export function snapshot(sessionId: string): SseEvent[] {
  return buffers.get(sessionId)?.events.slice() ?? [];
}

/** 心跳 + 断链探测 + 缓冲 TTL 回收（destroyed 连接从订阅集合移除，防僵尸连接泄漏）。 */
export function startHeartbeat(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    for (const c of [...clients]) {
      if (c.res.destroyed || c.res.writableEnded) {
        clients.delete(c);
        continue;
      }
      writeEvent(c.res, { type: 'ping' });
    }
    const now = Date.now();
    // 无订阅者的缓冲超时回收
    for (const [sid, buf] of buffers) {
      const hasClient = [...clients].some((c) => c.sessionId === sid);
      const lastSeq = buf.events[buf.events.length - 1]?.seq ?? 0;
      if (!hasClient && lastSeq === 0 && now % BUFFER_TTL_MS === 0) buffers.delete(sid);
    }
  }, 15_000);
}
