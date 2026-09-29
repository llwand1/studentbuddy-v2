/**
 * ai/call-log — `llm_call` 表的**唯一写入方**（总线订阅者）与只读统计。
 *
 * 写：订阅 `llm_call` 事件落一行（发布方是 `ai/gateway.ts`；网关本身不碰库，见其文件头）。
 * 读：`aiCallStats` 按用途汇总「调用数 / 成功率 / 各类失败 / 耗时 p50·p95 / token」，
 *     供设置页「AI 运行状况」卡和之后的提示词版本对比用。
 * ★ 统计**只看自己的调用**（owner 过滤）：平台通道的用户看不到别人的失败与用量。
 */
import type { AiCallStats, AiPurposeStats } from '@sb/shared';
import { subscribeEvents } from '../events/bus.js';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import type { LlmCallRecord } from './gateway.js';
import { AI_PURPOSES, isAiPurpose } from './purposes.js';

export function recordLlmCall(r: LlmCallRecord): void {
  getDb()
    .prepare(
      `INSERT INTO llm_call (id, owner_id, purpose, prompt_version, role, model, platform, status, attempt,
         latency_ms, prompt_tokens, completion_tokens, finish_reason, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id, ownerForWrite(r.ownerId), r.purpose, r.promptVersion, r.role, r.model, r.platform ? 1 : 0, r.status,
      r.attempt, Math.max(Math.round(r.latencyMs), 0), r.usage?.promptTokens ?? null, r.usage?.completionTokens ?? null,
      r.finishReason ?? null, r.error ? r.error.slice(0, 500) : null,
    );
}

let wired = false;
export function wireLlmCallLog(): void {
  if (wired) return;
  wired = true;
  subscribeEvents((ev) => {
    if (ev.type === 'llm_call') recordLlmCall(ev.record);
  });
}

/** 有序数组的分位数（最近秩）；空数组给 0 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

interface Row {
  purpose: string;
  status: string;
  latency_ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
  created_at: string;
  prompt_version: number;
}

/** 最近 `days` 天自己的调用，按用途汇总（耗时分位只算成功的调用：失败的超时会把 p95 拉成超时阈值本身） */
export function aiCallStats(ownerId: string | null, days = 7): AiCallStats {
  const span = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
  const rows = getDb()
    .prepare(
      `SELECT purpose, status, latency_ms, prompt_tokens, completion_tokens, error, created_at, prompt_version
         FROM llm_call WHERE owner_id = ? AND created_at >= datetime('now', ?) ORDER BY created_at DESC LIMIT 5000`,
    )
    .all(ownerForWrite(ownerId), `-${span} days`) as Row[];
  const by = new Map<string, Row[]>();
  for (const r of rows) by.set(r.purpose, [...(by.get(r.purpose) ?? []), r]);
  const purposes: AiPurposeStats[] = [...by.entries()].map(([purpose, list]) => {
    const ok = list.filter((r) => r.status === 'ok');
    const lat = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
    const failures: Record<string, number> = {};
    for (const r of list) if (r.status !== 'ok') failures[r.status] = (failures[r.status] ?? 0) + 1;
    return {
      purpose,
      label: isAiPurpose(purpose) ? AI_PURPOSES[purpose].label : purpose,
      version: list[0]?.prompt_version ?? 1,
      calls: list.length,
      ok: ok.length,
      failures,
      p50Ms: percentile(lat, 50),
      p95Ms: percentile(lat, 95),
      tokens: list.reduce((s, r) => s + (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0), 0),
    };
  });
  purposes.sort((a, b) => b.calls - a.calls);
  const recentFailures = rows
    .filter((r) => r.status !== 'ok')
    .slice(0, 8)
    .map((r) => ({
      purpose: r.purpose,
      label: isAiPurpose(r.purpose) ? AI_PURPOSES[r.purpose].label : r.purpose,
      status: r.status,
      error: r.error ?? '',
      at: r.created_at,
    }));
  return {
    days: span,
    calls: rows.length,
    ok: rows.filter((r) => r.status === 'ok').length,
    purposes,
    recentFailures,
  };
}
