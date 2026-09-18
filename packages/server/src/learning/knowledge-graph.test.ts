/**
 * learning/knowledge-graph 单测：节点幂等、防自环、边幂等、origin 分层、邻域子图与截断、
 * 结构推导边。零 LLM、零网络（纯 DB）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import {
  addEdge,
  deriveDomainEdges,
  ensureNode,
  getNode,
  graphStats,
  listNodes,
  neighborhood,
  purgeDerivedEdges,
  removeEdge,
} from './knowledge-graph.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-kgraph-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const term = (id: string, text: string, domain = 'english') => {
  getDb()
    .prepare(`INSERT INTO term_library (id, term, definition, domain, source_session_id) VALUES (?, ?, ?, ?, NULL)`)
    .run(id, text, `${text} 的释义`, domain);
  return ensureNode({ kind: 'term', refId: id, refText: text });
};

describe('knowledge-graph — 节点幂等与抗删快照', () => {
  it('同 kind + refId 重复登记 ⇒ 返回同一个节点（同一词条在两条流里仍是一个点）', () => {
    const a = term('t1', 'closure');
    const b = ensureNode({ kind: 'term', refId: 't1', refText: 'closure' });
    expect(b.id).toBe(a.id);
    expect(listNodes('term')).toHaveLength(1);
  });

  it('无 refId 的 concept 节点可重复登记（UNIQUE 允许多个 NULL）', () => {
    const a = ensureNode({ kind: 'concept', refId: null, refText: '本次学习的整体' });
    const b = ensureNode({ kind: 'concept', refId: null, refText: '另一次的整体' });
    expect(b.id).not.toBe(a.id);
  });

  it('refText 是抗删快照：源词条被删后节点仍在、仍可读', () => {
    const n = term('t9', 'subjunctive');
    getDb().prepare('DELETE FROM term_library WHERE id = ?').run('t9');
    const still = getNode(n.id);
    expect(still).not.toBeNull();
    expect(still!.refText).toBe('subjunctive');
  });
});

describe('knowledge-graph — 边：幂等 / 自环 / origin 分层', () => {
  it('同 (from,to,kind) 重复加边 ⇒ 返回既有边，不产生第二条', () => {
    const a = term('a', 'A');
    const b = term('b', 'B');
    const e1 = addEdge({ fromNodeId: a.id, toNodeId: b.id, kind: 'relates', origin: 'ai' });
    const e2 = addEdge({ fromNodeId: a.id, toNodeId: b.id, kind: 'relates', origin: 'derived' });
    expect(e2!.id).toBe(e1!.id);
    expect(e2!.origin).toBe('ai'); // 先到者胜，不被后来的覆盖
    expect(graphStats().edges).toBe(1);
  });

  it('自环边被丢弃（静默返回 null，不抛错）', () => {
    const a = term('a', 'A');
    expect(addEdge({ fromNodeId: a.id, toNodeId: a.id, kind: 'relates', origin: 'user' })).toBeNull();
    expect(graphStats().edges).toBe(0);
  });

  it('weight 越界被钳到 0~1', () => {
    const a = term('a', 'A');
    const b = term('b', 'B');
    expect(addEdge({ fromNodeId: a.id, toNodeId: b.id, kind: 'relates', origin: 'user', weight: 9 })!.weight).toBe(1);
  });

  it('purgeDerivedEdges 只删 derived——用户确认的边与 AI 抽取的边都留着', () => {
    const a = term('a', 'A');
    const b = term('b', 'B');
    const c = term('c', 'C');
    addEdge({ fromNodeId: a.id, toNodeId: b.id, kind: 'relates', origin: 'derived' });
    addEdge({ fromNodeId: a.id, toNodeId: c.id, kind: 'prereq', origin: 'user' });
    addEdge({ fromNodeId: b.id, toNodeId: c.id, kind: 'derived_from', origin: 'ai' });

    expect(purgeDerivedEdges()).toBe(1);
    const left = graphStats();
    expect(left.edges).toBe(2);
    expect(left.byOrigin.map((o) => o.origin).sort()).toEqual(['ai', 'user']);
  });

  it('removeEdge 按 id 精确删除', () => {
    const a = term('a', 'A');
    const b = term('b', 'B');
    const e = addEdge({ fromNodeId: a.id, toNodeId: b.id, kind: 'relates', origin: 'user' })!;
    expect(removeEdge(e.id)).toBe(true);
    expect(removeEdge(e.id)).toBe(false);
  });
});

describe('knowledge-graph — 邻域子图', () => {
  it('按深度展开（A-B-C-D，从 A 看 2 跳得 A/B/C，不含 D）', () => {
    const a = term('a', 'A');
    const b = term('b', 'B');
    const c = term('c', 'C');
    const d = term('d', 'D');
    addEdge({ fromNodeId: a.id, toNodeId: b.id, kind: 'relates', origin: 'derived' });
    addEdge({ fromNodeId: b.id, toNodeId: c.id, kind: 'relates', origin: 'derived' });
    addEdge({ fromNodeId: c.id, toNodeId: d.id, kind: 'relates', origin: 'derived' });

    const nb = neighborhood(a.id, 2)!;
    expect(nb.center.id).toBe(a.id);
    expect(nb.nodes.map((n) => n.refText).sort()).toEqual(['A', 'B', 'C']);
    expect(nb.truncated).toBe(false);
  });

  it('节点不存在 ⇒ 返回 null（路由据此回 404）', () => {
    expect(neighborhood('no-such-node', 2)).toBeNull();
  });

  it('超出节点上限时**如实置 truncated**（不把局部图冒充全图）', () => {
    const center = ensureNode({ kind: 'concept', refId: null, refText: '中心' });
    for (let i = 0; i < 70; i++) {
      const n = ensureNode({ kind: 'concept', refId: null, refText: `叶 ${i}` });
      addEdge({ fromNodeId: center.id, toNodeId: n.id, kind: 'relates', origin: 'derived' });
    }
    const nb = neighborhood(center.id, 1)!;
    expect(nb.truncated).toBe(true);
    expect(nb.nodes.length).toBeLessThanOrEqual(60);
  });
});

describe('knowledge-graph — 结构推导（origin=derived 的唯一产地）', () => {
  it('同域词条两两建 relates 边，且带规则名作为依据', () => {
    const a = term('a', 'closure', 'cs');
    const b = term('b', 'scope', 'cs');
    const c = term('c', 'hoisting', 'cs');
    expect(deriveDomainEdges([a.id, b.id, c.id], null)).toBe(3); // C(3,2)

    const stats = graphStats();
    expect(stats.edges).toBe(3);
    expect(stats.byOrigin).toEqual([{ origin: 'derived', count: 3 }]);
    const nb = neighborhood(a.id, 1)!;
    expect(nb.edges.every((e) => e.evidence?.startsWith('同域：'))).toBe(true);
  });

  it('不同域不建边；单节点不建边', () => {
    const a = term('a', 'closure', 'cs');
    const b = term('b', 'subjunctive', 'english');
    expect(deriveDomainEdges([a.id, b.id], null)).toBe(0);
    expect(deriveDomainEdges([a.id], null)).toBe(0);
  });
});
