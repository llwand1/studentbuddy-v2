/**
 * learning/scenario-flow — 情景演练步骤执行器（契约 SCENARIO-SPEC §8 M4，2026-09-17 新建）。
 *
 * ★ 本文件是 vitest 独立进程（默认 per-file 模块隔离），在这里调 registerDefaultExecutors
 *   不会污染 routes/study-flow.test.ts 的「测试进程执行器未注册 ⇒ 全部 wired:false」回归锁。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-scenario-flow-'));
const { registerDefaultExecutors } = await import('./flow-executors.js');
const { buildStepPrompt, getExecutor, clearExecutorsForTest } = await import('./flow-registry.js');
const { saveScenario, announceScenarioToSession } = await import('./scenario.js');
const { getDb, closeDb } = await import('../storage/db.js');

registerDefaultExecutors();

const ctx = (over: Record<string, unknown>) =>
  ({
    runId: 'r1',
    stepId: 's1',
    kind: 'scenario',
    params: {},
    sessionId: null,
    upstream: {},
    ...over,
  }) as Parameters<NonNullable<ReturnType<typeof getExecutor>>>[0];

afterAll(() => {
  clearExecutorsForTest();
  closeDb();
});

describe('scenario 步骤注册（第 7 种步骤，M4）', () => {
  it('scenario 有专用执行器（wired；其余步骤仍共享 chatStep）', () => {
    expect(getExecutor('scenario')).toBeDefined();
    // 翻译表哨兵：scenario 刻意不走 buildStepPrompt（聊天模型吐不出可接桥接的 demo）
    expect(() => buildStepPrompt('scenario', {})).toThrow(/专用执行器/);
  });

  it('没有会话 → 如实抛错，不静默跳过', async () => {
    const ex = getExecutor('scenario')!;
    await expect(ex(ctx({}))).rejects.toThrow(/会话/);
  });

  it('topic / material 全缺 → 抛入参闸门错误（同 REST 生成入口口径）', async () => {
    const ex = getExecutor('scenario')!;
    await expect(ex(ctx({ sessionId: 'sess-x' }))).rejects.toThrow(/topic 或 material/);
  });

  it('测试环境没配出题模型 → 抛「没配好」真因（不假装成功）', async () => {
    const ex = getExecutor('scenario')!;
    await expect(ex(ctx({ sessionId: 'sess-x', params: { topic: '电工安全' } }))).rejects.toThrow(/没配好/);
  });
});

describe('announceScenarioToSession（下发共享函数：REST 与编排执行器同一份）', () => {
  it('block 事件 + 历史落库一条 [SCENARIO] 登记文本（含 quizId/demoId 登记键）', async () => {
    const tasks = [
      { id: 't1', prompt: '选出危险源', criteria: { kind: 'choice' as const, answer: [1] } },
      { id: 't2', prompt: '完成断电操作', criteria: { kind: 'state' as const, key: 'power', value: 'off' } },
    ];
    const saved = saveScenario({ title: '下发测试', tasks }, '<!doctype html><html><body><button id="sb-t1"></button></body></html>', null);
    expect(saved).not.toBeNull();
    const gen = { quizId: saved!.quizId, demoId: saved!.demoId, payload: { title: '下发测试', tasks } };
    const sid = 'sess-announce-' + String(Date.now());
    // messages.session_id 有外键——真实链路里 run 的会话必存在（study-flow-run createRun 先建），
    // 这里照同一前提把会话行补上再下发
    getDb().prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(sid, '下发测试会话');
    announceScenarioToSession(sid, gen as Parameters<typeof announceScenarioToSession>[1]);
    const row = getDb()
      .prepare('SELECT content FROM messages WHERE session_id = ? AND role = ?')
      .get(sid, 'assistant') as { content: string };
    expect(row.content.startsWith('[SCENARIO]')).toBe(true);
    expect(row.content).toContain(`"quizId":"${saved!.quizId}"`);
    expect(row.content).toContain(`"demoId":"${saved!.demoId}"`);
    // 无订阅者不炸：publish 空转是安全路径（执行器后台跑时用户可能没开这个会话页）
  });
});
