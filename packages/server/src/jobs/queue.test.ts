/**
 * jobs/queue.test — 持久化后台任务：入队去重、认领、退避重试、永久失败、重启恢复、手动重试、内联降级，
 * 以及第一个真实任务「对话后抽词」的失败分类。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const extract = vi.hoisted(() => ({ result: { ok: true, items: [] } as unknown, calls: 0 }));
const saved = vi.hoisted(() => ({ n: 0 }));
const compacted = vi.hoisted(() => ({ n: 0 }));
vi.mock('../learning/terms.js', () => ({
  runTermExtraction: async () => {
    extract.calls += 1;
    return extract.result;
  },
  saveTerms: () => {
    saved.n += 1;
    return 1;
  },
}));
vi.mock('../chat/compact.js', () => ({
  compactIfNeeded: async () => {
    compacted.n += 1;
    return null;
  },
}));

const { openIsolated, closeDb, getDb } = await import('../storage/db.js');
const q = await import('./queue.js');
const w = await import('./worker.js');
const { runPostTurn, POST_TURN_JOB, afterTurn } = await import('../chat/post-turn.js');
const { scheduleMaintenance } = await import('./maintenance.js');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-jobs-'));
  openIsolated(dir);
  extract.result = { ok: true, items: [] };
  extract.calls = 0;
  saved.n = 0;
  compacted.n = 0;
});
afterEach(() => {
  w.stopJobWorker();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

function row(id: string) {
  return getDb().prepare('SELECT * FROM job WHERE id = ?').get(id) as import('./queue.js').JobRow;
}

describe('队列', () => {
  it('去重键撞上 ⇒ 只落一行', () => {
    expect(q.enqueueJob({ kind: 'k', ownerId: 'u', payload: {}, dedupeKey: 'same' })).not.toBeNull();
    expect(q.enqueueJob({ kind: 'k', ownerId: 'u', payload: {}, dedupeKey: 'same' })).toBeNull();
    expect(q.listJobs('u')).toHaveLength(1);
  });

  it('认领只拿到期的；认领即 running 且 attempts+1', () => {
    q.enqueueJob({ kind: 'later', ownerId: 'u', payload: {}, runAfter: Date.now() + 60_000 });
    const id = q.enqueueJob({ kind: 'now', ownerId: 'u', payload: {} })!;
    const got = q.claimJob();
    expect(got?.id).toBe(id);
    expect(row(id)).toMatchObject({ status: 'running', attempts: 1 });
    expect(q.claimJob()).toBeNull();
  });

  it('★ 失败退避：还有次数 ⇒ 回 queued 并推迟；用完 ⇒ failed', () => {
    const id = q.enqueueJob({ kind: 'k', ownerId: 'u', payload: {}, maxAttempts: 2 })!;
    const now = 1_000_000;
    let r = q.claimJob(now)!;
    expect(q.failJob(r, 'e1', false, now)).toBe('queued');
    expect(row(id).run_after).toBe(now + q.backoffMs(1));
    expect(q.claimJob(now)).toBeNull(); // 还没到退避时间
    r = q.claimJob(now + q.backoffMs(1))!;
    expect(q.failJob(r, 'e2', false, now)).toBe('failed');
    expect(row(id)).toMatchObject({ status: 'failed', last_error: 'e2', attempts: 2 });
  });

  it('退避序列 30s、2min、8min… 封顶 1 小时', () => {
    expect([1, 2, 3].map(q.backoffMs)).toEqual([30_000, 120_000, 480_000]);
    expect(q.backoffMs(10)).toBe(3_600_000);
  });

  it('永久失败不再重试', () => {
    const id = q.enqueueJob({ kind: 'k', ownerId: 'u', payload: {} })!;
    expect(q.failJob(q.claimJob()!, 'no model', true)).toBe('failed');
    expect(row(id).status).toBe('failed');
  });

  it('★ 重启恢复：卡在 running 的放回 queued', () => {
    const id = q.enqueueJob({ kind: 'k', ownerId: 'u', payload: {} })!;
    q.claimJob();
    expect(q.recoverStaleJobs()).toBe(1);
    expect(row(id).status).toBe('queued');
  });

  it('手动重试：只认自己的、只认 failed；归属按 IS 比（本地模式 null 也认）', () => {
    const id = q.enqueueJob({ kind: 'k', ownerId: null, payload: {} })!;
    q.failJob(q.claimJob()!, 'x', true);
    expect(q.retryJob(id, 'someone')).toBe(false);
    expect(q.retryJob(id, null)).toBe(true);
    expect(row(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(q.retryJob(id, null)).toBe(false); // 已经不是 failed
    expect(q.jobCounts(null).queued).toBe(1);
  });

  it('清理：删过期的 done，失败的留更久', () => {
    const a = q.enqueueJob({ kind: 'k', ownerId: 'u', payload: {} })!;
    const b = q.enqueueJob({ kind: 'k', ownerId: 'u', payload: {} })!;
    q.completeJob(a);
    q.failJob({ id: b, attempts: 3, max_attempts: 3 }, 'x');
    getDb().prepare(`UPDATE job SET updated_at = datetime('now', '-10 days')`).run();
    expect(q.pruneJobs(7)).toBe(1);
    expect(row(b)).toBeTruthy();
  });

  it('每日维护按本地日期去重：一天只落一行', () => {
    expect(scheduleMaintenance(new Date(2026, 8, 29, 1))).not.toBeNull();
    expect(scheduleMaintenance(new Date(2026, 8, 29, 23))).toBeNull();
    expect(scheduleMaintenance(new Date(2026, 8, 30, 1))).not.toBeNull();
  });
});

describe('执行器', () => {
  it('处理函数成功 ⇒ done；抛错 ⇒ 退避；PermanentJobError ⇒ failed', async () => {
    let mode: 'ok' | 'err' | 'perm' = 'ok';
    w.registerJobHandler('t.run', '测试', async () => {
      if (mode === 'err') throw new Error('flaky');
      if (mode === 'perm') throw new w.PermanentJobError('never');
    });
    const a = q.enqueueJob({ kind: 't.run', ownerId: 'u', payload: {} })!;
    expect(await w.runClaimed(q.claimJob()!)).toBe('done');
    mode = 'err';
    const b = q.enqueueJob({ kind: 't.run', ownerId: 'u', payload: {} })!;
    expect(await w.runClaimed(q.claimJob()!)).toBe('queued');
    expect(row(b).last_error).toBe('flaky');
    mode = 'perm';
    q.enqueueJob({ kind: 't.run', ownerId: 'u', payload: {} });
    expect(await w.runClaimed(q.claimJob()!)).toBe('failed');
    expect(row(a).status).toBe('done');
  });

  it('没登记的任务种类、坏载荷 ⇒ 直接 failed（不空转重试）', async () => {
    q.enqueueJob({ kind: 'nobody', ownerId: 'u', payload: {} });
    expect(await w.runClaimed(q.claimJob()!)).toBe('failed');
    const id = q.enqueueJob({ kind: 't.run', ownerId: 'u', payload: {} })!;
    getDb().prepare(`UPDATE job SET payload = '{bad' WHERE id = ?`).run(id);
    expect(await w.runClaimed(q.claimJob()!)).toBe('failed');
  });

  it('处理函数拿到的是原始 ownerId（本地模式 null 不被改成空串）', async () => {
    let seen: unknown = 'unset';
    w.registerJobHandler('t.owner', '测试', async (_p, ctx) => {
      seen = ctx.ownerId;
    });
    q.enqueueJob({ kind: 't.owner', ownerId: null, payload: {} });
    await w.drainJobs();
    expect(seen).toBeNull();
  });

  it('★ worker 没启动（单测/库导入）⇒ dispatchJob 内联执行，不落库', async () => {
    afterTurn({ sessionId: 's', text: '问', answer: '答', ownerId: 'u' });
    await new Promise((r) => setTimeout(r, 0));
    expect(extract.calls).toBe(1);
    expect(q.listJobs('u')).toHaveLength(0);
  });

  it('★ worker 启动后 ⇒ 入库、执行、留痕', async () => {
    w.startJobWorker(60_000);
    afterTurn({ sessionId: 's', text: '问', answer: '答', ownerId: 'u' });
    await vi.waitFor(() => expect(q.listJobs('u')[0]?.status).toBe('done'));
    expect(q.listJobs('u')[0]?.kind).toBe(POST_TURN_JOB);
  });

  // 2026-10-10 真机事故的守卫锁：迁移号撞车让 job 表缺失时，startJobWorker 里
  // recoverStaleJobs() 的 no such table 会把**整个服务**炸掉（桌面版实测崩在启动）。
  // 守卫层保证：表缺失 ⇒ 不炸、不启动轮询（dispatchJob 自动退回内联路径），主功能照常。
  it('★ 守卫：job 表缺失 ⇒ startJobWorker 不抛、不启动（修复前此处 no such table: job 直接冒泡）', () => {
    getDb().exec('DROP TABLE job');
    expect(q.jobTableReady()).toBe(false);
    expect(() => w.startJobWorker(60_000)).not.toThrow();
    expect(w.jobWorkerRunning()).toBe(false); // 未启动 ⇒ 后台任务退回内联执行（尽力而为）
  });
});

describe('对话后抽词（chat.post_turn）', () => {
  const payload = { sessionId: 's1', material: '闭包是函数和词法环境的组合' };

  it('抽到词条 ⇒ 落库 + 压缩', async () => {
    extract.result = { ok: true, items: [{ term: '闭包', definition: 'x' }] };
    await runPostTurn(payload, 'u');
    expect(saved.n).toBe(1);
    expect(compacted.n).toBe(1);
  });

  it('★ 超时/上游挂了 ⇒ 抛普通错误（交给队列重试），压缩照跑', async () => {
    extract.result = { ok: false, reason: 'timeout', error: '超时' };
    await expect(runPostTurn(payload, 'u')).rejects.not.toBeInstanceOf(w.PermanentJobError);
    expect(compacted.n).toBe(1);
  });

  it('★ 没配模型 ⇒ PermanentJobError（重试也没用）', async () => {
    extract.result = { ok: false, reason: 'no-model', error: '没配' };
    await expect(runPostTurn(payload, 'u')).rejects.toBeInstanceOf(w.PermanentJobError);
  });
});
