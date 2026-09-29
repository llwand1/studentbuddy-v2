/**
 * ai/call-log.test — `llm_call` 落库（经总线真打进订阅链）与 `aiCallStats` 汇总口径。
 * 锁：① 按用途分组、失败按原因计数；② 耗时分位**只算成功的**（超时会把 p95 拉成阈值本身）；
 *     ③ 只看得到自己的调用；④ 超出天数窗口的不算；⑤ `percentile` 最近秩口径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { reportLlmCall } from './gateway.js';
import { aiCallStats, percentile, wireLlmCallLog } from './call-log.js';
import { pruneLlmCalls } from '../jobs/maintenance.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-llmcall-'));
  openIsolated(dir);
  wireLlmCallLog();
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(over: Partial<Parameters<typeof reportLlmCall>[0]> = {}): void {
  reportLlmCall({ ownerId: 'u1', purpose: 'quiz.generate', role: 'quiz-generator', model: 'm', platform: false, status: 'ok', attempt: 1, latencyMs: 100, ...over });
}

describe('aiCallStats', () => {
  it('按用途汇总：调用数、成功数、失败按原因、token；用途带中文名', () => {
    call({ latencyMs: 100, usage: { promptTokens: 10, completionTokens: 5 } });
    call({ latencyMs: 300 });
    call({ status: 'timeout', latencyMs: 180_000 });
    call({ status: 'parse' });
    call({ purpose: 'term.extract', role: 'explain' });
    const s = aiCallStats('u1');
    expect(s.calls).toBe(5);
    expect(s.ok).toBe(3);
    const q = s.purposes.find((p) => p.purpose === 'quiz.generate')!;
    expect(q).toMatchObject({ label: '出题', calls: 4, ok: 2, failures: { timeout: 1, parse: 1 }, tokens: 15 });
    // ★ 超时那次 180 秒不进分位：p95 仍是成功调用里的 300
    expect(q.p95Ms).toBe(300);
    expect(q.p50Ms).toBe(100);
    expect(s.purposes[0]?.purpose).toBe('quiz.generate'); // 调用多的排前面
    expect(s.recentFailures.map((f) => f.status).sort()).toEqual(['parse', 'timeout']);
  });

  it('★ 只看得到自己的调用', () => {
    call({ ownerId: 'u1' });
    call({ ownerId: 'u2', status: 'upstream', error: '别人的错误' });
    expect(aiCallStats('u1').calls).toBe(1);
    expect(aiCallStats('u1').recentFailures).toHaveLength(0);
    expect(aiCallStats('u2').calls).toBe(1);
  });

  it('窗口外的不算；清理只删过期的', () => {
    call();
    call();
    getDb().prepare(`UPDATE llm_call SET created_at = datetime('now', '-100 days') WHERE rowid = (SELECT MIN(rowid) FROM llm_call)`).run();
    expect(aiCallStats('u1', 7).calls).toBe(1);
    expect(pruneLlmCalls()).toBe(1);
    expect(aiCallStats('u1', 90).calls).toBe(1);
  });

  it('错误原文截到 500 字，不让一条超长报文撑爆表', () => {
    call({ status: 'upstream', error: 'x'.repeat(2000) });
    const row = getDb().prepare('SELECT error FROM llm_call').get() as { error: string };
    expect(row.error.length).toBe(500);
  });
});

describe('percentile', () => {
  it('最近秩；空数组给 0', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4], 95)).toBe(4);
    expect(percentile([7], 99)).toBe(7);
  });
});
