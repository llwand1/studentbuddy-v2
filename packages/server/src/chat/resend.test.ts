/**
 * chat/resend —— 「编辑重发」数据侧回归（不触 LLM）。
 * 锁三件事：① 最后一条提问的内容被**更新**成新文案（不是追加一条新提问）；
 * ② 它之后的全部产物被删掉（与 regenerate 同一划界口径，按 rowid 防秒级 created_at 误删）；
 * ③ 空文案 / 没有提问时如实 ok:false，调用方据此 400。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import { planResend } from './resend.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-resend-'));
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

const rowsOf = (sessionId: string): Array<{ role: string; content: string }> =>
  getDb()
    .prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid')
    .all(sessionId) as Array<{ role: string; content: string }>;

describe('planResend（编辑重发的数据侧）', () => {
  it('更新最后一条提问内容，并删掉它之后的全部产物', () => {
    const sid = 's1';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    add(sid, 'user', '第一问');
    add(sid, 'assistant', '第一答');
    add(sid, 'user', '什么是闭包');
    add(sid, 'assistant', ''); // 工具轮
    add(sid, 'tool', '搜索结果');
    add(sid, 'assistant', '闭包是……');

    const plan = planResend(sid, '  什么是闭包（举个生活例子）  ');
    expect(plan.ok).toBe(true);
    expect(plan.text).toBe('什么是闭包（举个生活例子）');
    const rows = rowsOf(sid);
    expect(rows).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '什么是闭包（举个生活例子）' },
    ]);
  });

  it('提问内容是就地更新：消息条数不变、不产生第二条 user', () => {
    const sid = 's2';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    add(sid, 'user', '原问题');
    expect(planResend(sid, '改后的问题').ok).toBe(true);
    expect(rowsOf(sid)).toEqual([{ role: 'user', content: '改后的问题' }]);
  });

  it('纯空白文案拒绝（编辑成空再重发等于清空提问，不允许）', () => {
    const sid = 's3';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    add(sid, 'user', '原问题');
    const plan = planResend(sid, '   ');
    expect(plan.ok).toBe(false);
    // 拒绝时不许动库
    expect(rowsOf(sid)).toEqual([{ role: 'user', content: '原问题' }]);
  });

  it('会话里没有提问时如实报 ok:false', () => {
    const sid = 's4';
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES (?, '新对话')`).run(sid);
    add(sid, 'assistant', '凭空出现的回答');
    expect(planResend(sid, '新问题').ok).toBe(false);
  });
});
