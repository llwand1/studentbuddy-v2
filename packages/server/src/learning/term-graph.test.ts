/**
 * learning/term-graph.test — 关系任务（aiJson mock）、落边口径、邻居读取、对话混合检索、任务派发。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ai = vi.hoisted(() => ({ out: '' as string, fail: '' as string, calls: [] as Array<Array<{ content: string }>> }));
vi.mock('../ai/gateway.js', () => ({
  aiJson: async (opts: { parse: (t: string) => unknown; messages: Array<{ content: string }> }) => {
    ai.calls.push(opts.messages);
    if (ai.fail) return { ok: false, reason: ai.fail, error: '失败' };
    const value = opts.parse(ai.out);
    return value === null ? { ok: false, reason: 'parse', error: '不成形' } : { ok: true, value, text: ai.out, repaired: false };
  },
}));

const { openIsolated, closeDb, getDb } = await import('../storage/db.js');
const { saveOneTerm } = await import('./terms.js');
const { relateTerms, termRelations, neighborTerms, saveEdges } = await import('./term-graph.js');
const { PermanentJobError } = await import('../jobs/worker.js');
const { collectContextSegments } = await import('../chat/context-segments.js');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-graph-'));
  openIsolated(dir);
  ai.out = '';
  ai.fail = '';
  ai.calls = [];
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const U = 'u1';
const add = (term: string, domain = 'bio', owner = U) => saveOneTerm(term, `${term}的释义`, domain, owner).id;
const edges = (rels: Array<[string, string, string]>) => JSON.stringify({ edges: rels.map(([a, b, relation]) => ({ a, b, relation, note: '因为' })) });

describe('relateTerms（后台任务本体）', () => {
  it('★ 新词条与已有词条一起给模型；回来的边落库，两个方向都读得到', async () => {
    add('光反应');
    const dark = add('暗反应');
    ai.out = edges([['光反应', '暗反应', 'prerequisite']]);
    expect(await relateTerms({ termIds: [dark] }, U)).toBe(1);
    expect(ai.calls[0]?.[1]?.content).toMatch(/【新词条】\n- 暗反应[\s\S]*【已有词条】\n- 光反应/);
    const rel = termRelations(U, dark);
    expect(rel).toEqual([expect.objectContaining({ term: '光反应', relation: 'prerequisite', outgoing: false, label: '需要先懂', note: '因为' })]);
  });

  it('★ 重复抽取幂等；无向边正反只存一行', async () => {
    const a = add('有丝分裂');
    const b = add('减数分裂');
    ai.out = edges([['有丝分裂', '减数分裂', 'contrast'], ['减数分裂', '有丝分裂', 'contrast']]);
    await relateTerms({ termIds: [b] }, U);
    await relateTerms({ termIds: [a, b] }, U);
    expect((getDb().prepare('SELECT COUNT(*) AS c FROM term_edge').get() as { c: number }).c).toBe(1);
  });

  it('★ 没配模型 ⇒ 永久失败；上游失败 ⇒ 普通错误（交给退避）；不成形 ⇒ 0 不重试', async () => {
    add('甲');
    const b = add('乙');
    ai.fail = 'no-model';
    await expect(relateTerms({ termIds: [b] }, U)).rejects.toBeInstanceOf(PermanentJobError);
    ai.fail = 'timeout';
    await expect(relateTerms({ termIds: [b] }, U)).rejects.not.toBeInstanceOf(PermanentJobError);
    ai.fail = '';
    ai.out = '说不出来';
    expect(await relateTerms({ termIds: [b] }, U)).toBe(0);
  });

  it('只有一个词条、坏载荷、别人的词条 ⇒ 不调模型', async () => {
    const only = add('孤零零');
    expect(await relateTerms({ termIds: [only] }, U)).toBe(0);
    expect(await relateTerms({ termIds: 'x' }, U)).toBe(0);
    add('别人的', 'bio', 'u2');
    expect(await relateTerms({ termIds: [add('别人的2', 'bio', 'u2')] }, U)).toBe(0);
    expect(ai.calls).toHaveLength(0);
  });

  it('同名不同领域时优先连新词条', () => {
    const old = add('细胞', 'bio');
    const fresh = add('细胞', 'cs');
    const other = add('组织', 'bio');
    const b = (id: string, term: string, domain: string) => ({ id, term, definition: '', domain });
    saveEdges(U, [{ a: '细胞', b: '组织', relation: 'part_of', note: '' }], [b(fresh, '细胞', 'cs')], [b(old, '细胞', 'bio'), b(other, '组织', 'bio')]);
    expect(termRelations(U, fresh)).toHaveLength(1);
    expect(termRelations(U, old)).toHaveLength(0);
  });
});

describe('邻居与混合检索', () => {
  it('★ 一跳邻居：去掉已命中的，前置优先；别人的边看不见；删掉的词条不出现', () => {
    const hit = add('暗反应');
    const pre = add('光反应');
    const rel = add('叶绿体');
    const b = (id: string, term: string) => ({ id, term, definition: '', domain: 'bio' });
    saveEdges(U, [{ a: '叶绿体', b: '暗反应', relation: 'related', note: '' }, { a: '光反应', b: '暗反应', relation: 'prerequisite', note: '' }], [b(hit, '暗反应')], [b(pre, '光反应'), b(rel, '叶绿体')]);
    const row = (id: string) => getDb().prepare('SELECT * FROM term_library WHERE id = ?').get(id) as never;
    expect(neighborTerms(U, [row(hit)]).map((t) => t.term)).toEqual(['光反应', '叶绿体']);
    expect(neighborTerms('u2', [row(hit)])).toEqual([]);
    expect(neighborTerms(U, [row(hit), row(pre)]).map((t) => t.term)).toEqual(['叶绿体']);
    getDb().prepare('DELETE FROM term_library WHERE id = ?').run(rel);
    expect(neighborTerms(U, [row(hit)]).map((t) => t.term)).toEqual(['光反应']);
  });

  it('★ 对话注入段：字面命中之外带上关联词条', () => {
    const hit = add('暗反应');
    const pre = add('光反应');
    const b = (id: string, term: string) => ({ id, term, definition: '', domain: 'bio' });
    saveEdges(U, [{ a: '光反应', b: '暗反应', relation: 'prerequisite', note: '' }], [b(hit, '暗反应')], [b(pre, '光反应')]);
    const ctx = collectContextSegments({ history: [], sessionId: 's', text: '暗反应是什么', ownerId: U } as never);
    const terms = ctx.segments.find((s) => s.kind === 'terms')?.content ?? '';
    expect(terms).toContain('- 暗反应');
    expect(terms).toMatch(/直接关联[\s\S]*- 光反应/);
  });
});
