/**
 * chat/regenerate —— 重新生成的数据侧回归（不触 LLM）。
 * 锁的是「划界」这件事：删掉最后一条提问之后的**全部**产物，且提问本身一条不少。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import { planRegenerate } from './regenerate.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-regen-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function add(sessionId: string, role: string, content: string): void {
  getDb()
    .prepare(`INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), sessionId, role, content);
}

const rolesOf = (sessionId: string): string[] =>
  (
    getDb()
      .prepare('SELECT role FROM messages WHERE session_id = ? ORDER BY rowid')
      .all(sessionId) as Array<{ role: string }>
  ).map((r) => r.role);

describe('planRegenerate（重新生成的数据侧）', () => {
  it('返回最后一条提问原文，并删掉它之后的全部产物（含工具轮与中途半截）', () => {
    const sid = 's1';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    add(sid, 'user', '什么是闭包');
    add(sid, 'assistant', ''); // 工具轮首条（content 空）
    add(sid, 'tool', '搜索结果');
    add(sid, 'assistant', '闭包是函数和其词法环境的组合');
    add(sid, 'assistant', '（已停止）'); // 中止留下的半截

    const plan = planRegenerate(sid);
    expect(plan.ok).toBe(true);
    expect(plan.text).toBe('什么是闭包');
    // 只剩提问本身：工具轮、正常回答、中止半截全清
    expect(rolesOf(sid)).toEqual(['user']);
  });

  it('只重生成最后一条提问：更早的轮次原样保留', () => {
    const sid = 's2';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    add(sid, 'user', '第一问');
    add(sid, 'assistant', '第一答');
    add(sid, 'user', '第二问');
    add(sid, 'assistant', '第二答');

    const plan = planRegenerate(sid);
    expect(plan.text).toBe('第二问');
    expect(rolesOf(sid)).toEqual(['user', 'assistant', 'user']);
  });

  it('幂等：对同一会话再调一次不会把提问也吃掉', () => {
    const sid = 's3';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    add(sid, 'user', '唯一提问');
    add(sid, 'assistant', '旧回答');

    expect(planRegenerate(sid).text).toBe('唯一提问');
    expect(planRegenerate(sid).text).toBe('唯一提问');
    expect(rolesOf(sid)).toEqual(['user']);
  });

  it('会话里没有提问时如实报 ok:false（调用方据此给 400，不静默什么都不做）', () => {
    const sid = 's4';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    add(sid, 'assistant', '凭空出现的回答');
    const plan = planRegenerate(sid);
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain('没有可以重新生成');
  });

  it('空会话返回 ok:false 且不抛', () => {
    const sid = 's5';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    expect(planRegenerate(sid).ok).toBe(false);
  });
});
