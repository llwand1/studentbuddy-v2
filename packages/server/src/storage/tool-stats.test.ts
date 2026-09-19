/**
 * storage/tool-stats —— `tool_called` 订阅落库与窗口汇总（契约 §4.5，v1.4 拍板⑰，P3 收口批）。
 *
 * 测的是**接线**而不是调度器：发布方 tool-exec.test 立着「不触 DB」的边界（那边已锁
 * 事件字段来源），这里从 `publishEvent` 真打进订阅链落库——走事件不走直调，
 * 因为「订阅方抛错由 ADR-4 兜底、发布方零感知」正是选这条接线的理由，绕开总线测就等于没测。
 *
 * 三条口径死锁：① `affected` NULL≠0（没改与改了 0 条是两回事，v32 耗时列同口径）；
 * ② `session_id` 的 `''` 是哨兵不是缺失；③ `sessionAffectedTotal` 按 (owner, session) 双条件——
 * 单条件时拿别人会话 id 就能探「他被 AI 改了多少条」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from './db.js';
import { publishEvent } from '../events/bus.js';
import type { DomainEvent } from '../events/bus.js';
import { wireToolStats, summarizeToolStats, sessionAffectedTotal } from './tool-stats.js';

type ToolCalled = Extract<DomainEvent, { type: 'tool_called' }>;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-toolstats-'));
  openIsolated(dir);
  wireToolStats(); // 幂等单例（同 wireObsEvents 套路），重复 wire 不双写
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(over: Partial<ToolCalled> & { tool: string }): void {
  publishEvent({
    type: 'tool_called',
    sessionId: null,
    ownerId: null,
    source: 'builtin',
    ok: true,
    ms: 10,
    affected: null,
    resultChars: 0,
    err: null,
    confirm: null,
    ...over,
  });
}

function rows(tool?: string): Array<Record<string, unknown>> {
  return (tool
    ? getDb().prepare('SELECT * FROM tool_stats WHERE tool = ? ORDER BY ms').all(tool)
    : getDb().prepare('SELECT * FROM tool_stats').all()) as Array<Record<string, unknown>>;
}

describe('tool-stats — 事件到库的接线', () => {
  it('publishEvent 同步落一行：哨兵列（session 空串/affected null/confirm null）原样', () => {
    call({ tool: 'search_web', ms: 42, resultChars: 7 });
    const [row] = rows('search_web');
    expect(row).toMatchObject({ owner_id: '', session_id: '', tool: 'search_web', source: 'builtin', ok: 1, ms: 42, result_chars: 7 });
    expect(row?.affected).toBeNull(); // 读工具：没改 ≠ 改了 0 条（事后审计的 NULL/0 分界）
    expect(row?.confirm).toBeNull(); // 没经过门，不是「免批通过」
  });

  it('err 摘要写侧截 200 字（读取面不再防）；失败行 ok=0', () => {
    call({ tool: 'search_web', ok: false, err: 'E'.repeat(300) });
    const row = rows('search_web')[0];
    expect(String(row?.err)).toHaveLength(200);
    expect(row?.ok).toBe(0);
  });

  it('wire 幂等：再 wire 一次不双写（一行计数只 +1）', () => {
    wireToolStats();
    wireToolStats();
    call({ tool: 'lookup_terms' });
    expect(rows('lookup_terms')).toHaveLength(1);
  });
});

describe('tool-stats — summarizeToolStats（设置页「工具」卡数据源）', () => {
  it('按工具聚合：calls/failures/p95（11 样本取上点＝ceil(0.95n) 位）/affected 合计/放行与拒绝留痕', () => {
    for (let i = 1; i <= 10; i++) call({ tool: 'upsert_term', ms: i * 10, affected: 1, confirm: 'allow_once' });
    call({ tool: 'upsert_term', ok: false, ms: 999, err: 'boom' });
    call({ tool: 'delete_terms', ms: 5, affected: null, confirm: 'deny' });
    call({ tool: 'delete_terms', ms: 6, affected: null, confirm: 'timeout' });
    call({ tool: 'tidy_terms', ms: 8, affected: 0, confirm: null }); // 免确认档：留痕 null、改 0 条
    const s = summarizeToolStats(null);
    const byName = new Map(s.map((x) => [x.tool, x]));
    // 11 样本：ceil(0.95×11)−1=10 → 第 11 小＝999（上插值口径，慢尾不被均值洗掉）
    expect(byName.get('upsert_term')).toMatchObject({ calls: 11, failures: 1, p95Ms: 999, affectedTotal: 10, confirmAllowed: 10 });
    expect(byName.get('delete_terms')).toMatchObject({ calls: 2, confirmDenied: 2, affectedTotal: 0 });
    expect(byName.get('tidy_terms')).toMatchObject({ calls: 1, affectedTotal: 0, confirmAllowed: 0, confirmDenied: 0 });
  });

  it('窗口按人隔离 + days 钳位（1..90）：别人的行不进我的卡', () => {
    call({ tool: 'upsert_term', ownerId: 'u1', affected: 3 });
    call({ tool: 'upsert_term', ownerId: 'u2' });
    expect(summarizeToolStats('u1')[0]?.affectedTotal).toBe(3);
    expect(summarizeToolStats('u2')[0]?.affectedTotal).toBe(0);
    expect(summarizeToolStats(null)).toHaveLength(0); // 无主视角看不到任何人的
    expect(summarizeToolStats('u1', 999)[0]?.calls).toBe(1); // 钳到 90 不抛
  });

  it('窗口外的老行不参与统计（30 天口径），改 created_at 即可验证（假时钟的 SQL 版）', () => {
    call({ tool: 'search_web', ms: 1 });
    getDb().prepare("UPDATE tool_stats SET created_at = datetime('now', '-40 days')").run();
    expect(summarizeToolStats(null)).toHaveLength(0);
    expect(summarizeToolStats(null, 60)).toHaveLength(1); // 放宽到 60 天又回来了：钳位与窗口都活
  });

  it('mcp 来源标记随行带出（external 工具统计不混进内建）', () => {
    call({ tool: 'ext_thing', source: 'mcp' });
    expect(summarizeToolStats(null)[0]).toMatchObject({ tool: 'ext_thing', source: 'mcp' });
  });
});

describe('tool-stats — sessionAffectedTotal（绕过面事后审计）', () => {
  it('按 (owner, session) 双条件聚合：NULL 按没改计 0，别人的同名片段进不来', () => {
    call({ tool: 'upsert_term', sessionId: 'sess-a', ownerId: 'u1', affected: 2 });
    call({ tool: 'delete_terms', sessionId: 'sess-a', ownerId: 'u1', affected: 5, confirm: 'allow_once' });
    call({ tool: 'lookup_terms', sessionId: 'sess-a', ownerId: 'u1' }); // NULL 行
    call({ tool: 'upsert_term', sessionId: 'sess-a', ownerId: 'u2', affected: 100 }); // 同会话名不同人
    call({ tool: 'upsert_term', sessionId: 'sess-b', ownerId: 'u1', affected: 7 }); // 同主人不同会话
    expect(sessionAffectedTotal('sess-a', 'u1')).toBe(7);
    expect(sessionAffectedTotal('sess-a', 'u2')).toBe(100);
    expect(sessionAffectedTotal('sess-nope', 'u1')).toBe(0);
  });

  it('无会话调用落哨兵行：不污染任何真会话的合计', () => {
    call({ tool: 'upsert_term', sessionId: null, ownerId: null, affected: 9 });
    expect(sessionAffectedTotal('', null)).toBe(9); // 显式查哨兵可见（审计口径：哨兵也是事实）
    expect(sessionAffectedTotal('sess-x', null)).toBe(0);
  });
});
