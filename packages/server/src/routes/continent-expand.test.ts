/**
 * routes/continent-expand 端到端（supertest）：开拓地块两步——`POST /api/continent/expand/offer` → `/claim`。
 *
 * 钉五件事：
 *  ① **只有边界格能领**：不挨着任何地块的空格 409、已铺词条的格 409、坐标不是整数 400。
 *  ② 没绑模型 ⇒ 词条来自内置词池，`source='fallback'` 且 `fallbackReason` 有人话——降级必须如实标记（ADR-5）。
 *  ③ 题目**由服务端出、由服务端判**：答错 409（offer 不作废，可重答）；答对 ⇒ 词条入库 + **钉在点的那一格**
 *     （地图端点铺出来就在那格，不是螺旋的下一格）；同一份 nonce 落第二次 404。
 *  ④ 新词条**不算复习过**（`last_reviewed_at` 空）——刚学会的词条要由复习引擎按正常节律接管，不是"白送一次打卡"。
 *  ⑤ 荒地领地格不能领（边界口径与前端画「+」一致）——这里用"空大陆"验证 409 文案，领地依赖时间，交给 shared 单测。
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gradeAnswer, layoutTiles, type ContinentAnswer, type ContinentExpandOffer, type ContinentQuestion } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-continent-expand-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { resetExpandOffersForTest } = await import('../learning/continent-expand.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

interface MapTerm {
  id: string;
  term: string;
  definition: string;
  created_at: string;
  last_reviewed_at: string | null;
}
interface MapPayload {
  terms: MapTerm[];
  pins: Array<{ id: string; row: number; col: number }>;
}

const addTerm = async (term: string, domain = 'js'): Promise<string> => {
  const res = await request(app)
    .post('/api/terms')
    .set('Origin', origin)
    .send({ term, definition: `${term} 的释义`, domain })
    .expect(201);
  return (res.body as { id: string }).id;
};

const map = async (): Promise<MapPayload> => (await request(app).get('/api/terms/review/map').expect(200)).body as MapPayload;

const offer = (row: number, col: number) =>
  request(app).post('/api/continent/expand/offer').set('Origin', origin).send({ row, col });
const claim = (nonce: string, answers: unknown) =>
  request(app).post('/api/continent/expand/claim').set('Origin', origin).send({ nonce, answers });

/** 按题面算出正确作答（判分口径只有 shared 一份，这里只是"作弊本"） */
function solve(q: ContinentQuestion): ContinentAnswer {
  switch (q.type) {
    case 'judge':
      return q.answer;
    case 'choice':
    case 'scene':
      return q.answerIndex;
    case 'fill':
      return q.answer;
    case 'match':
      return q.answer;
  }
}
/** 故意答错（每种题型都有一个必错值） */
function spoil(q: ContinentQuestion): ContinentAnswer {
  switch (q.type) {
    case 'judge':
      return !q.answer;
    case 'choice':
    case 'scene':
      return (q.answerIndex + 1) % q.options.length;
    case 'fill':
      return `${q.answer}错`;
    case 'match':
      return q.answer.map(() => -1);
  }
}

afterAll(() => closeDb());
beforeEach(() => resetExpandOffersForTest());

describe('开拓地块', () => {
  it('⑤ 空大陆没有边界 ⇒ 409 并告诉用户先存第一条词条', async () => {
    const res = await offer(0, 1).expect(409);
    expect((res.body as { error: string }).error).toContain('先在「词条」页存第一条词条');
  });

  it('① 坐标不是整数 400；不挨着地块的空格 409；已铺词条的格 409', async () => {
    await addTerm('闭包');
    await offer(0.5, 1).expect(400);
    await offer(5, 5).expect(409);
    const taken = await offer(0, 0).expect(409);
    expect((taken.body as { error: string }).error).toContain('不能开拓');
  });

  it('② 没绑模型 ⇒ 词池兜底：source=fallback + fallbackReason；题目两道、题型来自可玩题型且不重复', async () => {
    const res = await offer(0, 1).expect(200);
    const o = res.body as ContinentExpandOffer;
    expect(o).toMatchObject({ row: 0, col: 1, source: 'fallback' });
    expect(o.fallbackReason).toMatch(/模型|词池/);
    expect(o.term.length).toBeGreaterThan(0);
    expect(o.definition.length).toBeGreaterThan(0);
    expect(o.questions).toHaveLength(2);
    expect(new Set(o.questions.map((q) => q.type)).size).toBe(2);
    expect(o.expiresAt).toBeGreaterThan(Date.now());
    // 每道题都能用"作弊本"答对——即 offer 里的题面自洽（服务端判的就是这份）
    for (const q of o.questions) expect(gradeAnswer(q, solve(q))).toBe(true);
  });

  it('③ 答错 409 且 offer 不作废；答对 ⇒ 入库 + 钉在点的那一格；同 nonce 再落 404；作答形状不对 400', async () => {
    const before = await map();
    const o = (await offer(0, 1).expect(200)).body as ContinentExpandOffer;
    await claim(o.nonce, 'nope').expect(400);
    await claim(o.nonce, [solve(o.questions[0] as ContinentQuestion)]).expect(400);
    const wrong = await claim(o.nonce, [spoil(o.questions[0] as ContinentQuestion), solve(o.questions[1] as ContinentQuestion)]).expect(409);
    expect((wrong.body as { error: string }).error).toContain('第 1 题');
    // 没写库
    expect((await map()).terms).toHaveLength(before.terms.length);

    const ok = await claim(o.nonce, o.questions.map(solve)).expect(200);
    const result = ok.body as { termId: string; term: string; row: number; col: number; source: string };
    expect(result).toMatchObject({ term: o.term, row: 0, col: 1, source: 'fallback' });

    const after = await map();
    expect(after.terms).toHaveLength(before.terms.length + 1);
    expect(after.pins).toContainEqual({ id: result.termId, row: 0, col: 1 });
    // 用同一份铺格函数：新词条落在 (0,1)，而不是螺旋序的下一格
    const tiles = layoutTiles(after.terms, after.pins);
    expect(tiles.find((t) => t.term.id === result.termId)).toMatchObject({ row: 0, col: 1 });
    // ④ 不算复习过
    const saved = after.terms.find((t) => t.id === result.termId);
    expect(saved?.last_reviewed_at).toBeNull();

    await claim(o.nonce, o.questions.map(solve)).expect(404);
  });

  it('③ 领了一格后别处又把它占了 ⇒ 落地 409（格已不是空地），且不重复入库', async () => {
    // (1,0) 与 (0,1) 一样紧挨 (0,0)。先领 (1,0)，再用另一份 offer 把 (1,0) 落掉，第一份就落不成
    const a = (await offer(1, 0).expect(200)).body as ContinentExpandOffer;
    const b = (await offer(1, 0).expect(200)).body as ContinentExpandOffer;
    await claim(b.nonce, b.questions.map(solve)).expect(200);
    const n = (await map()).terms.length;
    const res = await claim(a.nonce, a.questions.map(solve)).expect(409);
    expect((res.body as { error: string }).error).toContain('不是空地');
    expect((await map()).terms).toHaveLength(n);
  });

  it('钉子只增不删：删了词条那格回到"可开拓"（铺格只认有词条的钉子）；撤销删除 ⇒ 地块回到原格', async () => {
    const o = (await offer(-1, 0).expect(200)).body as ContinentExpandOffer;
    const r = (await claim(o.nonce, o.questions.map(solve)).expect(200)).body as { termId: string };
    await request(app).delete(`/api/terms/${r.termId}`).set('Origin', origin).expect(200);
    const gone = await map();
    expect(gone.terms.some((t) => t.id === r.termId)).toBe(false);
    expect(layoutTiles(gone.terms, gone.pins).some((t) => t.row === -1 && t.col === 0)).toBe(false);
    await offer(-1, 0).expect(200); // 那格又能领了
    // 钉子还在表里（零删钉子的设计）⇒ 撤销删除后词条落回 (-1,0)，而不是螺旋末尾
    const batches = (await request(app).get('/api/terms/delete-batches').expect(200)).body as Array<{ batch: string }>;
    const batch = batches[0]?.batch;
    if (!batch) throw new Error('应有可撤销记录');
    await request(app).post('/api/terms/undo-delete').set('Origin', origin).send({ batch }).expect(200);
    const back = await map();
    expect(layoutTiles(back.terms, back.pins).find((t) => t.term.id === r.termId)).toMatchObject({ row: -1, col: 0 });
  });
});
