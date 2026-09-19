/**
 * storage/tool-stats — 工具调用统计的落库与汇总查询（契约 TOOL-ECOSYSTEM-SPEC §4.5，v1.4 拍板⑰）。
 *
 * 定位：`events/bus` 的订阅消费端，抄 `storage/obs.ts` 的既有分工——
 * 发布方（chat/tool-exec.ts 调度器单点）只管 `publishEvent({type:'tool_called'})`，
 * 对落库零感知；订阅者抛错由 bus 的 ADR-4 兜底（只记日志、不阻塞对话主链），
 * 故本文件不再自行 try/catch，避免双份口径。
 *
 * ★ 为什么走事件而不是调度器直写（契约 §7 原写「tool-exec 单点写 tool_stats」，落码时改接线）：
 *   `getDb()` 是**惰性开真库**的，而 `tool-exec.test.ts`/`registry.test.ts` 立的是「不触 DB」的测试边界
 *   ——调度器里一行 getDb() 就会在开发机上生成真文件、把策略测试变成库测试。
 *   事件订阅把「计时与调度」和「存储」重新分家，调度器侧保持零 DB（obs 发布方同款）。
 *
 * 数据消费方（设置页「工具」卡，P3 步骤 7）：每工具 30 天调用数 / 失败数 / p95 耗时 / 累计 affected；
 * 另有「本会话 AI 累计改动 N 条」＝按会话聚合 affected（§4.6 已知绕过面的事后审计）。
 */
import { getDb } from './db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { subscribeEvents } from '../events/bus.js';
import type { DomainEvent } from '../events/bus.js';

type ToolCalledEvent = Extract<DomainEvent, { type: 'tool_called' }>;

/** 失败摘要截断上限（契约 SQL 注释「≤200 字」）：在写侧截，读取面就不必再防 */
const ERR_SNIPPET_CHARS = 200;

/** 落一行调用统计。`session_id` 的 `''`＝无会话哨兵（v35 注释），归属走 `ownerForWrite` 同读写口径。 */
function recordToolCall(ev: ToolCalledEvent): void {
  getDb()
    .prepare(
      `INSERT INTO tool_stats (owner_id, session_id, tool, source, ok, affected, ms, result_chars, err, confirm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ownerForWrite(ev.ownerId),
      ev.sessionId ?? '',
      ev.tool,
      ev.source,
      ev.ok ? 1 : 0,
      ev.affected,
      ev.ms,
      ev.resultChars,
      ev.err ? ev.err.slice(0, ERR_SNIPPET_CHARS) : null,
      ev.confirm,
    );
}

export interface ToolStatSummary {
  tool: string;
  source: 'builtin' | 'mcp';
  calls: number;
  failures: number;
  /** 95 分位耗时（ms，样本内插值取上点）；无样本不会有这行，恒有值 */
  p95Ms: number;
  /** 窗口内实际改动条数合计（NULL 行按没改计 0——绕过面审计要的是总量） */
  affectedTotal: number;
  confirmAllowed: number;
  confirmDenied: number;
}

/**
 * 按人聚合的窗口统计（默认 30 天）。p95 在 JS 侧排序取点而不是 SQL：
 * SQLite 无百分位函数，`OFFSET ceil(0.95*n)` 要每工具一条子查询——行数在这个量级（单机、
 * 每调用一行、30 天窗口）下全量拉进内存排序更简单也不构成瓶颈，判据同 v33「不加索引」注释。
 */
export function summarizeToolStats(ownerId: string | null, days = 30): ToolStatSummary[] {
  const clamped = Math.min(Math.max(Math.trunc(days), 1), 90);
  const rows = getDb()
    .prepare(
      `SELECT tool, source, ok, ms, affected, confirm
         FROM tool_stats
        WHERE owner_id = ? AND created_at >= datetime('now', ?)`,
    )
    .all(ownerForWrite(ownerId), `-${clamped} days`) as Array<{
    tool: string;
    source: string;
    ok: number;
    ms: number;
    affected: number | null;
    confirm: string | null;
  }>;
  const byTool = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byTool.get(r.tool);
    if (list) list.push(r);
    else byTool.set(r.tool, [r]);
  }
  return [...byTool.entries()].map(([tool, list]) => {
    const msSorted = list.map((r) => r.ms).sort((a, b) => a - b);
    return {
      tool,
      source: list[0]?.source === 'mcp' ? ('mcp' as const) : ('builtin' as const),
      calls: list.length,
      failures: list.filter((r) => r.ok === 0).length,
      p95Ms: msSorted[Math.max(0, Math.ceil(0.95 * msSorted.length) - 1)] ?? 0,
      affectedTotal: list.reduce((sum, r) => sum + (r.affected ?? 0), 0),
      confirmAllowed: list.filter((r) => r.confirm === 'allow_once' || r.confirm === 'allow_session').length,
      confirmDenied: list.filter((r) => r.confirm === 'deny' || r.confirm === 'timeout').length,
    };
  });
}

/**
 * 本会话 AI 累计改动条数（确认门「已知绕过面」的事后审计数字，§4.6）。
 * ★ 按 `(owner_id, session_id)` 双条件查，不是偷懒只查会话——单条件时拿别人的会话 id
 *   就能探「他这轮被 AI 改了多少条」，与 v34 撤销接口的归属校验同口径（404 同形那套）。
 */
export function sessionAffectedTotal(sessionId: string, ownerId: string | null): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(affected), 0) AS n FROM tool_stats WHERE owner_id = ? AND session_id = ?')
    .get(ownerForWrite(ownerId), sessionId) as { n: number };
  return row.n;
}

/** 启动时注册事件订阅（幂等：模块单例，同 `wireObsEvents` 套路） */
let wired = false;
export function wireToolStats(): void {
  if (wired) return;
  wired = true;
  subscribeEvents((ev) => {
    if (ev.type === 'tool_called') recordToolCall(ev);
  });
}
