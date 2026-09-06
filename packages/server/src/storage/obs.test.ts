import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated } from './db.js';
import { recordObsEvent, listObsEvents, wireObsEvents } from './obs.js';
import { publishEvent } from '../events/bus.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-obs-test-'));
}

describe('storage/obs — 可观测地基（v9 event_log）', () => {
  it('v9 迁移：event_log 表与双索引存在', () => {
    const db = openIsolated(tmp());
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toContain('event_log');
    const idx = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_event_log_kind_ts');
    expect(idx).toContain('idx_event_log_ts');
  });

  it('record + list：字段回读、payload JSON 还原、未传字段为 null、id 倒序', () => {
    openIsolated(tmp());
    const id1 = recordObsEvent({ kind: 'search_empty', payload: { query: 'test', failed: 'x: y' } });
    expect(id1).toBeGreaterThan(0);
    recordObsEvent({ kind: 'tool_error', sessionId: 's1', latencyMs: 12, tokensIn: 3, tokensOut: 5 });
    const rows = listObsEvents();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('tool_error'); // 倒序：后插的在前
    expect(rows[0]?.sessionId).toBe('s1');
    expect(rows[0]?.latencyMs).toBe(12);
    expect(rows[0]?.payload).toBeNull();
    expect(rows[1]?.payload).toEqual({ query: 'test', failed: 'x: y' });
    expect(rows[1]?.sessionId).toBeNull();
  });

  it('list 过滤：kind 精确 / sinceId 增量 / limit 钳制 1..200', () => {
    openIsolated(tmp());
    for (let i = 0; i < 5; i++) {
      recordObsEvent({ kind: i % 2 === 0 ? 'search_empty' : 'tool_error' });
    }
    expect(listObsEvents({ kind: 'search_empty' })).toHaveLength(3);
    const all = listObsEvents();
    const mid = all[2]?.id;
    const since = listObsEvents({ sinceId: mid });
    expect(since).toHaveLength(2);
    expect(since.every((r) => (mid ?? 0) < r.id)).toBe(true);
    expect(listObsEvents({ limit: 2 })).toHaveLength(2);
    expect(listObsEvents({ limit: 999 })).toHaveLength(5); // 上钳 200，数据只有 5
    expect(listObsEvents({ limit: 0 })).toHaveLength(1); // 下钳 1
    expect(listObsEvents({ kind: 'thumbs_down' })).toHaveLength(0); // 合法 kind 无数据
  });

  it('wireObsEvents：publishEvent(obs) 自动落库；重复 wire 幂等；非 obs 事件不落', () => {
    openIsolated(tmp());
    wireObsEvents();
    wireObsEvents();
    publishEvent({ type: 'obs', kind: 'search_empty', payload: { query: 'q' } });
    publishEvent({ type: 'chat_done', sessionId: 's' });
    const rows = listObsEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('search_empty');
    expect(rows[0]?.payload).toEqual({ query: 'q' });
  });
});
