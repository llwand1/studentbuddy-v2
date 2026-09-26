/**
 * routes/continent 端到端（supertest）：知识大陆地图端点 `GET /api/terms/review/map`（S6）。
 *
 * 钉三件事：
 *  ① **与 `/review/overview` 的差别**：概览只要「复习范围内」的词条，地图要**全部**——
 *     范围外的词条也必须在地图上出现（并在前端铺成不冒怪的普通地块）。
 *     这条最容易被后续重构"顺手收敛"掉，故单列一条。
 *  ② 每条带 `review`（现算状态）+ `review_in_scope`（**服务端**的有效范围结论）。
 *     前端判「该不该冒怪」只读它、不自己 COALESCE 一次（双份范围口径的先例见 term-review 头注）。
 *  ③ **解锁 = 既有打卡端点**：地图本身只读，答对后 `mark` 推进阶段，状态离开 due/overdue。
 *     ⇒ 「怪自然消失」不需要任何新写口（SPEC §4.2 零新表）。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-continent-test-'));
const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

interface MapTerm {
  id: string;
  term: string;
  definition: string;
  review_stage: number;
  review: { status: string; overdueDays: number; stage: number };
  review_in_scope: number;
}

/** 建词条；`inScope=false` 造「范围外」的词条（v28 起新词条默认**不在**范围，老板拍板） */
const addTerm = async (term: string, inScope: boolean): Promise<string> => {
  const res = await request(app)
    .post('/api/terms')
    .set('Origin', origin)
    .send({ term, definition: `${term} 的释义`, domain: 'math' })
    .expect(201);
  const id = (res.body as { id: string }).id;
  if (inScope) {
    await request(app)
      .put('/api/terms/review/scope')
      .set('Origin', origin)
      .send({ termId: id, enabled: true })
      .expect(200);
  }
  return id;
};

/** 把某词条的上次复习时间往回拨 N 天（造欠账；与 term-review.test.ts 同手法） */
const age = (id: string, days: number): void => {
  getDb()
    .prepare(`UPDATE term_library SET last_reviewed_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${days} days`, id);
};

const map = async (): Promise<MapTerm[]> => {
  const res = await request(app).get('/api/terms/review/map').expect(200);
  return (res.body as { terms: MapTerm[] }).terms;
};

afterAll(() => closeDb());

describe('知识大陆地图', () => {
  it('**全部**词条都在图上——范围外的也在（这是与 /review/overview 的唯一差别）', async () => {
    const inScope = await addTerm('在范围内', true);
    const outScope = await addTerm('范围外', false);
    const terms = await map();
    const ids = terms.map((t) => t.id);
    expect(ids).toContain(inScope);
    expect(ids).toContain(outScope);
    // 概览只数范围内 ⇒ 它看不见「范围外」这条，地图却看得见
    const ov = await request(app).get('/api/terms/review/overview').expect(200);
    const total = (ov.body as { total: number }).total;
    expect(terms.length).toBeGreaterThan(total);
  });

  it('每条带现算的 review 与**服务端**的范围结论 review_in_scope', async () => {
    const outScope = await addTerm('范围外二号', false);
    const terms = await map();
    const hit = terms.find((t) => t.id === outScope);
    expect(hit?.review_in_scope).toBe(0);
    expect(hit?.review.status).toBeTypeOf('string');
  });

  it('逾期词条在地图上标 overdue（怪占格的判据）', async () => {
    const id = await addTerm('欠账词条', true);
    age(id, 30);
    const hit = (await map()).find((t) => t.id === id);
    expect(hit?.review.status).toBe('overdue');
    expect(hit?.review.overdueDays).toBeGreaterThan(0);
  });

  it('解锁 = 既有打卡端点：答对推进阶段后状态离开 overdue（怪随之消失，零新写口）', async () => {
    const id = await addTerm('待消灭的怪', true);
    age(id, 30);
    expect((await map()).find((t) => t.id === id)?.review.status).toBe('overdue');
    await request(app).post(`/api/terms/${id}/review`).set('Origin', origin).send({ remembered: true }).expect(200);
    const after = (await map()).find((t) => t.id === id);
    expect(after?.review.status).not.toBe('overdue');
    expect(after?.review.stage).toBe(1);
  });

  it('按入库时间升序（前端依次填螺旋格，谁在内圈只有一个答案）', async () => {
    const terms = await map();
    const created = terms.map((t) => {
      const row = getDb().prepare('SELECT created_at FROM term_library WHERE id = ?').get(t.id) as {
        created_at: string;
      };
      return row.created_at;
    });
    expect([...created].sort()).toEqual(created);
  });
});