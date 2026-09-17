/**
 * learning/study-flow-run 单测：步进式推进、暂停/恢复、定义快照隔离、防死循环、
 * 未接执行器如实报错、失败收尾、取消。
 *
 * ★ 全部注入 fake executor（`clearExecutorsForTest` + `registerExecutor`）——
 *   默认执行器会走 `handleMessage`（真 LLM），CI 里跑不了，也不该跑。
 *   本文件因此完全不触 LLM，只验**状态机本身**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { FLOW_MAX_STEPS } from '@sb/shared';
import { clearExecutorsForTest, registerExecutor } from './flow-registry.js';
import type { FlowStepContext, FlowStepOutcome } from './flow-registry.js';
import { createDef, updateDef } from './study-flow.js';
import { advanceRun, cancelRun, createRun, getRun } from './study-flow-run.js';
import { listNodes } from './knowledge-graph.js';

let dir: string;
/** 记录 fake 执行器被调用的顺序（验「走的是哪一步」） */
let calls: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-flowrun-'));
  openIsolated(dir);
  clearExecutorsForTest();
  calls = [];
});

afterEach(() => {
  clearExecutorsForTest();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ok = (kind: string, extra?: Partial<FlowStepOutcome>) => async (ctx: FlowStepContext): Promise<FlowStepOutcome> => {
  calls.push(`${kind}:${ctx.stepId}`);
  return { output: { ran: kind }, ...extra };
};

/** 三步线性流：讲解 → 出题（会停等）→ 总结 */
const linear = {
  name: '线性三步',
  steps: [
    { id: 's1', kind: 'explain' as const, params: { topic: '闭包' } },
    { id: 's2', kind: 'quiz' as const, params: { topic: '闭包' } },
    { id: 's3', kind: 'summary' as const, params: {} },
  ],
  edges: [
    { fromStepId: 's1', toStepId: 's2' },
    { fromStepId: 's2', toStepId: 's3' },
  ],
};

function makeRun() {
  const r = createDef(linear);
  if (!r.ok) throw new Error(r.error);
  const run = createRun(r.def.id);
  if (!run.ok) throw new Error(run.error);
  return { defId: r.def.id, runId: run.run.id, sessionId: run.run.sessionId! };
}

describe('study-flow-run — 步进式推进', () => {
  it('每次只走一步；走到没有下一步时收尾为 done', async () => {
    const { runId } = makeRun();
    registerExecutor('explain', ok('explain'));
    registerExecutor('quiz', ok('quiz'));
    registerExecutor('summary', ok('summary'));

    const a1 = await advanceRun(runId);
    expect(a1.ok).toBe(true);
    if (!a1.ok) return;
    expect(a1.executed?.kind).toBe('explain');
    expect(a1.run.status).toBe('running');
    expect(a1.run.stepCount).toBe(1);

    const a2 = await advanceRun(runId);
    expect(a2.ok).toBe(true);
    if (!a2.ok) return;
    expect(a2.executed?.kind).toBe('quiz');
    expect(a2.run.stepCount).toBe(2);

    const a3 = await advanceRun(runId);
    expect(a3.ok).toBe(true);
    if (!a3.ok) return;
    expect(a3.executed?.kind).toBe('summary');

    // 第四步：没有下一步 ⇒ 正常收尾
    const a4 = await advanceRun(runId);
    expect(a4.ok).toBe(true);
    if (!a4.ok) return;
    expect(a4.executed).toBeNull();
    expect(a4.note).toContain('终点');
    expect(a4.run.status).toBe('done');
    expect(calls).toEqual(['explain:s1', 'quiz:s2', 'summary:s3']);
  });

  it('quiz 步（注册表声明 awaitsUser）⇒ 跑完停下等用户，并留下停等说明', async () => {
    const { runId } = makeRun();
    registerExecutor('explain', ok('explain'));
    registerExecutor('quiz', ok('quiz'));

    await advanceRun(runId); // explain
    const a2 = await advanceRun(runId); // quiz
    expect(a2.ok).toBe(true);
    if (!a2.ok) return;
    expect(a2.run.status).toBe('paused');
    expect(a2.run.currentStepId).toBe('s2');
    expect(a2.run.pauseReason).toBeTruthy();
  });

  it('暂停态**可以继续推进**（恢复语义；否则第二步之后永远推不动）', async () => {
    const { runId } = makeRun();
    registerExecutor('explain', ok('explain'));
    registerExecutor('quiz', ok('quiz'));
    registerExecutor('summary', ok('summary'));

    await advanceRun(runId);
    const paused = await advanceRun(runId);
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.run.status).toBe('paused');

    const resumed = await advanceRun(runId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.executed?.kind).toBe('summary');
    expect(resumed.run.status).toBe('running'); // 已翻回 running
    expect(resumed.run.pauseReason).toBeNull();
  });

  it('已 done 的运行不能再推进（409 语义）', async () => {
    const { runId } = makeRun();
    registerExecutor('explain', ok('explain'));
    registerExecutor('quiz', ok('quiz'));
    registerExecutor('summary', ok('summary'));
    await advanceRun(runId);
    await advanceRun(runId);
    await advanceRun(runId);
    await advanceRun(runId); // 收尾 done

    const r = await advanceRun(runId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toContain('done');
  });
});

describe('study-flow-run — 定义快照隔离（本批最关键的不变量）', () => {
  it('创建运行后再改定义，运行仍按**当时的定义**走', async () => {
    const { defId, runId } = makeRun();
    registerExecutor('explain', ok('explain'));
    registerExecutor('quiz', ok('quiz'));
    registerExecutor('summary', ok('summary'));
    registerExecutor('digest', ok('digest'));

    // 把定义整体换掉（步骤全变）
    const r = updateDef(defId, {
      name: '换过的流',
      steps: [{ id: 'z1', kind: 'digest', params: { domain: 'math' } }],
      edges: [],
    });
    expect(r.ok).toBe(true);

    const a1 = await advanceRun(runId);
    expect(a1.ok).toBe(true);
    const a2 = await advanceRun(runId);
    expect(a2.ok).toBe(true);
    if (!a2.ok) return;
    // 第二步走的是**快照里的** quiz，而不是新定义里唯一的 digest
    expect(a2.executed?.kind).toBe('quiz');
    expect(calls).toEqual(['explain:s1', 'quiz:s2']);
    expect(calls.some((c) => c.startsWith('digest'))).toBe(false);
    expect(getRun(runId)!.defVersion).toBe(1);
    expect(r.ok && r.def.version).toBe(2);
  });

  it('运行详情不带定义表内容，只认自己的快照（定义被删也照样能跑完）', async () => {
    const { defId, runId } = makeRun();
    registerExecutor('explain', ok('explain'));
    registerExecutor('quiz', ok('quiz'));
    registerExecutor('summary', ok('summary'));
    // 直接删掉定义表里的步骤（模拟定义被改坏/被删）
    getDb().prepare('DELETE FROM flow_step WHERE def_id = ?').run(defId);
    getDb().prepare('DELETE FROM flow_edge WHERE def_id = ?').run(defId);

    const a1 = await advanceRun(runId);
    expect(a1.ok).toBe(true);
    if (!a1.ok) return;
    expect(a1.executed?.kind).toBe('explain');
  });
});

describe('study-flow-run — 如实报错（不静默）', () => {
  it('步骤类型没接执行器 ⇒ 运行失败，错误里点名是哪种类型 + 待接清单位置', async () => {
    const { runId } = makeRun();
    // 只注册 explain，故意不注册 s1 之外的类型
    registerExecutor('explain', ok('explain'));

    const a1 = await advanceRun(runId);
    expect(a1.ok).toBe(true); // 第一步 explain 有执行器

    const a2 = await advanceRun(runId); // 第二步 quiz 没有
    expect(a2.ok).toBe(false);
    if (a2.ok) return;
    expect(a2.status).toBe(409);
    expect(a2.error).toContain('quiz');
    expect(a2.error).toContain('尚未接入执行器');
    expect(getRun(runId)!.status).toBe('failed');
  });

  it('执行器抛错 ⇒ 该步标 failed、运行标 failed，错误原文留档', async () => {
    const { runId } = makeRun();
    registerExecutor('explain', async () => {
      throw new Error('模型连接超时');
    });

    const a = await advanceRun(runId);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.status).toBe(502);
    expect(a.error).toContain('模型连接超时');

    const run = getRun(runId, true)!;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('模型连接超时');
    expect(run.steps![0]!.status).toBe('failed');
    expect(run.steps![0]!.error).toContain('模型连接超时');
  });

  it('超过步数上限 ⇒ 中止并说明是防死循环保护（不是静默截断）', async () => {
    const { runId } = makeRun();
    registerExecutor('explain', ok('explain'));
    // 直接把已执行步数顶到上限，省去循环 30 次
    getDb().prepare('UPDATE flow_run SET step_count = ? WHERE id = ?').run(FLOW_MAX_STEPS, runId);

    const a = await advanceRun(runId);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error).toContain('防死循环');
    expect(getRun(runId)!.status).toBe('failed');
  });
});

describe('study-flow-run — 取消与产物', () => {
  it('暂停中的运行可被取消；已结束的取消返回 null（幂等，不炸）', async () => {
    const { runId } = makeRun();
    registerExecutor('explain', ok('explain'));
    registerExecutor('quiz', ok('quiz'));
    await advanceRun(runId);
    await advanceRun(runId); // paused

    const c = cancelRun(runId, '用户不学了');
    expect(c).not.toBeNull();
    expect(c!.status).toBe('cancelled');
    expect(cancelRun(runId, '再取消一次')).toBeNull();
  });

  it('产出词条的步骤会把词条登记成知识节点（本会话内新增才算）', async () => {
    const r = createDef({
      name: '沉淀一步',
      steps: [{ id: 'd1', kind: 'digest' as const, params: { domain: 'english' } }],
      edges: [],
    });
    if (!r.ok) return;
    const created = createRun(r.def.id);
    if (!created.ok) return;
    const { id: runId } = created.run;
    const sessionId = created.run.sessionId!;

    registerExecutor('digest', async (ctx) => {
      // 模拟这一步「跑出了词条」：真的往 term_library 插一行（带本会话来源）
      getDb()
        .prepare(`INSERT INTO term_library (id, term, definition, domain, source_session_id) VALUES (?, ?, ?, ?, ?)`)
        .run('t-1', 'subjunctive', '虚拟语气', 'english', ctx.sessionId);
      return { output: { ran: 'digest' } };
    });

    const a = await advanceRun(runId);
    expect(a.ok).toBe(true);

    const nodes = listNodes('term');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.refText).toBe('subjunctive');
    expect(nodes[0]!.sourceRunId).toBe(runId);
    expect(nodes[0]!.sourceStepId).toBe('d1');
    expect(sessionId).toBeTruthy();
  });
});
