/**
 * pk/question-pool — 对战题预生成池：补到目标数、不合法/重复不入池、失败有上限；
 * 取题先进先出、排除本局已出题干、取过即不再发、并发只一个拿到；过期不取；worker 不在跑时不补。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizQuestion } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { POOL_TARGET, addToPool, isUsableSingle, poolSize, poolTopicKey, refillPool, requestRefill, takePooled } from './question-pool.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pkpool-'));
  openIsolated(dir);
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const q = (stem: string, answer: unknown = 1): QuizQuestion =>
  ({ type: 'single', question: stem, options: ['甲', '乙', '丙', '丁'], answer }) as unknown as QuizQuestion;

describe('isUsableSingle / poolTopicKey', () => {
  it('答案须是合法下标；主题键归一', () => {
    expect(isUsableSingle(q('a'))).toBe(true);
    expect(isUsableSingle(q('a', [2]))).toBe(true);
    expect(isUsableSingle(q('a', 9))).toBe(false);
    expect(isUsableSingle(q('a', 'B'))).toBe(false);
    expect(isUsableSingle(undefined)).toBe(false);
    expect(poolTopicKey('  世界  历史 ')).toBe('世界 历史');
  });
});

describe('refillPool', () => {
  it('★ 补到目标数即停；不合法与重复题干不入池', async () => {
    const seq = [q('一'), q('一'), q('坏', 7), q('二'), q('三'), q('四')];
    const gen = vi.fn(async () => seq.shift());
    const added = await refillPool('地理', gen);
    expect(added).toBe(POOL_TARGET);
    expect(poolSize('地理')).toBe(POOL_TARGET);
    expect(gen).toHaveBeenCalledTimes(5);
  });
  it('一直失败 ⇒ 最多试 5 次', async () => {
    const gen = vi.fn(async () => {
      throw new Error('x');
    });
    expect(await refillPool('地理', gen)).toBe(0);
    expect(gen).toHaveBeenCalledTimes(5);
  });
  it('池已满 ⇒ 不调模型', async () => {
    for (const s of ['一', '二', '三']) addToPool('地理', q(s));
    const gen = vi.fn(async () => q('四'));
    expect(await refillPool('地理', gen)).toBe(0);
    expect(gen).not.toHaveBeenCalled();
  });
});

describe('takePooled', () => {
  it('★ 先进先出、排除本局已出题干、取过不再发', () => {
    addToPool('地理', q('一'));
    addToPool('地理', q('二'));
    expect(takePooled('地理', new Set(['一']))?.question).toBe('二');
    expect(takePooled('地理')?.question).toBe('一');
    expect(takePooled('地理')).toBeNull();
    expect(takePooled('历史')).toBeNull();
  });
  it('过期题不取；坏 JSON 跳过', () => {
    addToPool('地理', q('旧'));
    getDb().prepare(`UPDATE pk_question_pool SET created_at = datetime('now', '-40 days')`).run();
    getDb().prepare(`INSERT INTO pk_question_pool (id, topic, stem, question) VALUES ('bad', '地理', '坏', '{')`).run();
    addToPool('地理', q('新'));
    expect(takePooled('地理')?.question).toBe('新');
  });
});

describe('requestRefill', () => {
  it('worker 不在跑 ⇒ 什么也不做（不在测试/脚本里真调出题）', () => {
    requestRefill('地理');
    expect(poolSize('地理')).toBe(0);
  });
});
