/**
 * routes/drill 端到端（supertest）：等待时刷词的三个写口 `POST /api/drill/new-terms | /keep | /dismiss`。
 *
 * 钉六件事：
 *  ① 没绑模型 ⇒ 新词来自内置词池：`mode='fallback'`、每条 `source='fallback'` 且 `fallbackReason` 有人话、`candidateId` 为空；
 *     **不含**用户库里已有的词（`drawablePool` 去重）。
 *  ② **先消化 pending 候选**：候选表里躺着 ≥3 条 pending 时，不问模型、不退词池，`mode='pending'` 原样给出（带 candidateId）。
 *  ③ 「收入词库」（候选）：以候选表那行为准落库（body 里的 term 篡改无效）、候选翻 `approved`、返回 termId；再点一次幂等 200。
 *  ④ 「收入词库」（词池条目，无 candidateId）：按 body 落库；缺字段 400。
 *  ⑤ 「不要」：候选翻 `rejected`、再点 409、不存在 404、缺 id 400；驳回后 `new-terms` 不再给它。
 *  ⑥ 模型输出解析：`parseDrillCandidates` 只收成形的条目（超长 / 缺字段整条丢，`domain` 缺省 general）。
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DrillKeepResult, DrillNewTermsResult } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-drill-test-'));
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { parseDrillCandidates } = await import('../learning/drill.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

const addTerm = async (term: string, definition = `${term} 的释义`, domain = 'js'): Promise<string> => {
  const res = await request(app).post('/api/terms').set('Origin', origin).send({ term, definition, domain });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
};

const newTerms = async (): Promise<DrillNewTermsResult> => {
  const res = await request(app).post('/api/drill/new-terms').set('Origin', origin).send({});
  expect(res.status).toBe(200);
  return res.body as DrillNewTermsResult;
};

const insertCandidate = (id: string, term: string, status = 'pending'): void => {
  getDb()
    .prepare(
      `INSERT INTO term_pool_candidate (id, owner_id, term, domain, definition, aliases, status, source)
       VALUES (?, '', ?, 'algo', ?, '[]', ?, 'ai')`,
    )
    .run(id, term, `${term} 的释义`, status);
};

const candidateStatus = (id: string): string | undefined =>
  (getDb().prepare('SELECT status FROM term_pool_candidate WHERE id = ?').get(id) as { status: string } | undefined)?.status;

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM term_library').run();
  db.prepare('DELETE FROM term_pool_candidate').run();
});

afterAll(() => {
  closeDb();
  fs.rmSync(process.env.SB_DATA_DIR as string, { recursive: true, force: true });
});

describe('POST /api/drill/new-terms', () => {
  it('① 没绑模型 ⇒ 词池兜底，如实标 fallback，且不含用户已有的词', async () => {
    await addTerm('主动回忆', '不看答案先自己想', 'learn');
    const r = await newTerms();
    expect(r.mode).toBe('fallback');
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(3);
    for (const it of r.items) {
      expect(it.source).toBe('fallback');
      expect(it.candidateId).toBeNull();
      expect(it.fallbackReason ?? '').toMatch(/内置词池/);
      expect(it.term).not.toBe('主动回忆');
      expect(it.definition.trim()).not.toBe('');
    }
    expect(r.fallbackReason ?? '').toMatch(/没有绑定可用的模型/);
  });

  it('② 候选表里有 ≥3 条 pending 时先消化它们（不退词池、带 candidateId）', async () => {
    insertCandidate('c1', '拓扑排序');
    insertCandidate('c2', '并查集');
    insertCandidate('c3', '最短路径');
    insertCandidate('c4', '前缀和', 'rejected');
    const r = await newTerms();
    expect(r.mode).toBe('pending');
    expect(r.items.map((x) => x.candidateId).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(r.items.every((x) => x.source === 'ai')).toBe(true);
    expect(r.items.map((x) => x.term)).not.toContain('前缀和');
  });

  it('② 补充：pending 里已被存进词库的那条不再给；不够 3 条时用下一级补齐', async () => {
    insertCandidate('c1', '拓扑排序');
    insertCandidate('c2', '并查集');
    insertCandidate('c3', '最短路径');
    await addTerm('拓扑排序', '有向无环图的线性次序', 'algo');
    const r = await newTerms();
    // 只剩 2 条合格 pending（< 3）⇒ 先给这 2 条，再用下一级补齐 1 条（没模型 ⇒ 词池）
    expect(r.mode).toBe('pending');
    expect(r.items).toHaveLength(3);
    expect(r.items.map((x) => x.term)).not.toContain('拓扑排序');
    expect(r.items.filter((x) => x.source === 'ai').map((x) => x.candidateId).sort()).toEqual(['c2', 'c3']);
    expect(r.items.filter((x) => x.source === 'fallback')).toHaveLength(1);
    expect(r.fallbackReason ?? '').toMatch(/内置词池/);
  });
});

describe('POST /api/drill/keep', () => {
  it('③ 候选收入词库：以候选表为准、候选翻 approved、幂等', async () => {
    insertCandidate('c9', '并查集');
    const res = await request(app)
      .post('/api/drill/keep')
      .set('Origin', origin)
      .send({ candidateId: 'c9', term: '被篡改的名字', definition: 'x', domain: 'zzz' });
    expect(res.status).toBe(200);
    const body = res.body as DrillKeepResult;
    expect(body.ok).toBe(true);
    expect(body.term).toBe('并查集');
    expect(body.candidateApproved).toBe(true);
    expect(candidateStatus('c9')).toBe('approved');
    const rows = getDb().prepare('SELECT term, domain, last_reviewed_at FROM term_library').all() as Array<{
      term: string;
      domain: string;
      last_reviewed_at: string | null;
    }>;
    expect(rows).toEqual([{ term: '并查集', domain: 'algo', last_reviewed_at: null }]);
    // 再点一次：候选已处理，词条已在 ⇒ 仍 200，不重复建
    const again = await request(app).post('/api/drill/keep').set('Origin', origin).send({ candidateId: 'c9' });
    expect(again.status).toBe(200);
    expect((again.body as DrillKeepResult).termId).toBe(body.termId);
    expect((again.body as DrillKeepResult).candidateApproved).toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM term_library').get()).toEqual({ n: 1 });
  });

  it('④ 词池条目（无 candidateId）按 body 落库；缺字段 400；候选不存在 404', async () => {
    const ok = await request(app)
      .post('/api/drill/keep')
      .set('Origin', origin)
      .send({ term: '交错练习', definition: '把不同类型的题混着练', domain: 'learn' });
    expect(ok.status).toBe(200);
    expect((ok.body as DrillKeepResult).term).toBe('交错练习');
    const bad = await request(app).post('/api/drill/keep').set('Origin', origin).send({ term: '只有词没有释义' });
    expect(bad.status).toBe(400);
    const missing = await request(app).post('/api/drill/keep').set('Origin', origin).send({ candidateId: 'nope' });
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/drill/dismiss', () => {
  it('⑤ 驳回留行：翻 rejected、再点 409、不存在 404、缺 id 400；之后 new-terms 不再给它', async () => {
    insertCandidate('d1', '滑动窗口');
    insertCandidate('d2', '双指针');
    insertCandidate('d3', '单调栈');
    const r1 = await request(app).post('/api/drill/dismiss').set('Origin', origin).send({ candidateId: 'd1' });
    expect(r1.status).toBe(200);
    expect(candidateStatus('d1')).toBe('rejected');
    expect((await request(app).post('/api/drill/dismiss').set('Origin', origin).send({ candidateId: 'd1' })).status).toBe(409);
    expect((await request(app).post('/api/drill/dismiss').set('Origin', origin).send({ candidateId: 'zz' })).status).toBe(404);
    expect((await request(app).post('/api/drill/dismiss').set('Origin', origin).send({})).status).toBe(400);
    const r = await newTerms();
    expect(r.items.map((x) => x.term)).not.toContain('滑动窗口');
  });
});

describe('parseDrillCandidates', () => {
  it('⑥ 只收成形条目：缺字段 / 超长整条丢，domain 缺省 general，包在废话里的 JSON 也能抠出来', () => {
    const text = `好的，如下：{"candidates":[{"term":"分块","definition":"把长内容切成小块记","domain":"Learn"},{"term":"","definition":"x"},{"term":"${'长'.repeat(41)}","definition":"y"},{"term":"无领域","definition":"z"}]} 完毕`;
    expect(parseDrillCandidates(text)).toEqual([
      { term: '分块', definition: '把长内容切成小块记', domain: 'learn' },
      { term: '无领域', definition: 'z', domain: 'general' },
    ]);
    expect(parseDrillCandidates('没有 json')).toBeNull();
    expect(parseDrillCandidates('{"candidates":[]}')).toBeNull();
  });
});
