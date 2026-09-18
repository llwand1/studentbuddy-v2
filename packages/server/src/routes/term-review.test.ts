/**
 * routes/term-review 端到端（supertest，同 notes.test.ts 手法）。
 *
 * 钉四件事：① 到期/逾期的判定与队列排序（先还旧账）；② 打卡的推进与归零；
 * ③ 入参校验与 404；④ 写接口吃同一道跨源闸门。
 * ★ 造「逾期」的办法是直接改 `last_reviewed_at`（`datetime('now','-N days')`），
 *   不是改系统时间——天数判定与真实时钟同源，改时钟会让用例与 CI 时区纠缠。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-term-review-test-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

interface ReviewBody {
  id: string;
  term: string;
  review_stage: number;
  last_reviewed_at: string | null;
  review: { stage: number; daysSince: number; overdueDays: number; status: string; intervalDays: number };
}

const addTerm = async (term: string, domain = 'math'): Promise<string> => {
  const res = await request(app)
    .post('/api/terms')
    .set('Origin', origin)
    .send({ term, definition: `${term} 的释义`, domain })
    .expect(201);
  return (res.body as { id: string }).id;
};

/** 把某词条的上次复习时间往回拨 N 天（造欠账） */
const age = (id: string, days: number): void => {
  getDb()
    .prepare(`UPDATE term_library SET last_reviewed_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${days} days`, id);
};

const overview = async () => {
  const res = await request(app).get('/api/terms/review/overview').expect(200);
  return res.body as {
    total: number;
    due: number;
    overdue: number;
    fresh: number;
    todayDone: number;
    mastered: number;
    maxOverdueDays: number;
    recent: Array<{ day: string; done: number }>;
  };
};

const queue = async (limit?: number) => {
  const res = await request(app).get(limit ? `/api/terms/review/queue?limit=${limit}` : '/api/terms/review/queue').expect(200);
  return res.body as ReviewBody[];
};

const mark = (id: string, remembered: boolean) =>
  request(app).post(`/api/terms/${id}/review`).set('Origin', origin).send({ remembered });

afterAll(() => closeDb());

describe('词条复习 — 到期判定与队列', () => {
  it('刚入库的词条：fresh 计 1、不进队列（第一次复习在 1 天后）', async () => {
    await addTerm('闭包');
    const ov = await overview();
    expect(ov.total).toBeGreaterThanOrEqual(1);
    expect(ov.fresh).toBeGreaterThanOrEqual(1);
    expect((await queue()).map((t) => t.term)).not.toContain('闭包');
  });

  it('欠账 3 天（stage0 间隔 1 天）→ 进队列、逾期 2 天、status=overdue', async () => {
    const id = await addTerm('柯里化');
    age(id, 3);
    const q = await queue();
    const hit = q.find((t) => t.id === id);
    // 状态由服务端算好返回：前端不再自己判一次，两边不可能打脸
    expect(hit?.review).toMatchObject({ stage: 0, daysSince: 3, overdueDays: 2, status: 'overdue', intervalDays: 1 });
    const ov = await overview();
    expect(ov.overdue).toBeGreaterThanOrEqual(1);
    expect(ov.maxOverdueDays).toBeGreaterThanOrEqual(2);
  });

  it('★ 先还旧账：逾期 10 天排在逾期 2 天之前', async () => {
    const old = await addTerm('单调栈');
    const recent = await addTerm('并查集');
    age(old, 10);
    age(recent, 2);
    const q = await queue();
    expect(q.findIndex((t) => t.id === old)).toBeLessThan(q.findIndex((t) => t.id === recent));
  });

  it('limit 归一（0 / 负数 / 巨大值都不炸，且不超过队列长度）', async () => {
    await queue(0);
    await queue(-5);
    const q = await queue(1);
    expect(q.length).toBeLessThanOrEqual(1);
  });
});

describe('词条复习 — 打卡', () => {
  it('记住了 → 推进一个节点（0→1），并立刻离开队列；忘了 → 归零', async () => {
    const id = await addTerm('记忆化搜索');
    age(id, 5);
    const done = await mark(id, true).expect(200);
    expect((done.body as ReviewBody).review_stage).toBe(1);
    expect((done.body as ReviewBody).review.intervalDays).toBe(2); // 阶段 1 = 2 天后
    expect((await queue()).map((t) => t.id)).not.toContain(id);

    const forgot = await mark(id, false).expect(200);
    expect((forgot.body as ReviewBody).review_stage).toBe(0); // 经典重来
    expect((forgot.body as ReviewBody).review.daysSince).toBe(0);
  });

  it('今日已复习按词条去重（同一条复习三次只算一个）', async () => {
    const id = await addTerm('汉诺塔');
    age(id, 9);
    const before = await overview();
    await mark(id, true).expect(200);
    await mark(id, true).expect(200);
    const after = await overview();
    expect(after.todayDone - before.todayDone).toBe(1);
    expect(after.recent.at(-1)?.done).toBeGreaterThanOrEqual(1);
  });

  it('校验与 404：remembered 非布尔 400；词条不存在 404', async () => {
    const id = await addTerm('拓扑排序');
    await mark(id, 'true' as unknown as boolean).expect(400);
    await request(app).post(`/api/terms/${id}/review`).set('Origin', origin).send({}).expect(400);
    await mark('no-such-term-id', true).expect(404);
  });

  it('写操作无 Origin → 403（与其余写接口同一道闸门）', async () => {
    await request(app).post('/api/terms/x/review').send({ remembered: true }).expect(403);
  });
});
