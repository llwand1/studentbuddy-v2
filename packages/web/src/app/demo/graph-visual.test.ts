/**
 * graph-visual —— 邻域图渲染纯逻辑的回归锁。
 *
 * 这组用例锁的是「肉眼看不出错、但一错就整张图不可信」的四件事：
 * ① 边端点必须缩到**卡片外沿**（缩多了箭头悬空、缩少了压在卡片上，都靠几何精确解）；
 * ② 二跳节点必须落在**其父的角度扇区**内（否则会飘到无关分支那边，看起来像连错了边）；
 * ③ 同一份数据必须摆出**同一张图**（非确定性摆位 = 每次刷新图都在转，用户会以为数据变了）；
 * ④ 三种 `origin` 的视觉分档必须**真的不一样**（契约 §4.2：AI 幻觉边不许和用户确认边长得一样）。
 */
import { describe, it, expect } from 'vitest';
import type { KnowledgeEdge, KnowledgeNeighborhood, KnowledgeNode } from './graph-types';
import {
  GRAPH_VIEW,
  NODE_BOX,
  canRemoveEdge,
  clipLabel,
  edgeClass,
  edgeKindLabel,
  edgeOriginLabel,
  layoutNeighborhood,
  nodeClass,
  nodeKindLabel,
  rectEdgePoint,
} from './graph-visual';

// ── 造数据 helper（只填被测逻辑会读到的字段）──

const node = (id: string, kind: KnowledgeNode['kind'] = 'term'): KnowledgeNode => ({
  id,
  kind,
  refId: id,
  refText: id,
  sourceRunId: null,
  sourceStepId: null,
  createdAt: '2026-09-17T00:00:00.000Z',
});

const edge = (
  from: string,
  to: string,
  origin: KnowledgeEdge['origin'] = 'user',
  kind: KnowledgeEdge['kind'] = 'relates',
): KnowledgeEdge => ({
  id: `${from}->${to}`,
  fromNodeId: from,
  toNodeId: to,
  kind,
  origin,
  weight: 1,
  evidence: null,
  createdAt: '2026-09-17T00:00:00.000Z',
});

const nb = (centerId: string, others: string[], edges: KnowledgeEdge[]): KnowledgeNeighborhood => ({
  center: node(centerId),
  nodes: [node(centerId), ...others.map((o) => node(o))],
  edges,
  truncated: false,
});

describe('rectEdgePoint —— 边与卡片边缘的精确交点', () => {
  it('正右方向：交点在右边缘中点', () => {
    const p = rectEdgePoint(0, 0, 100, 0);
    expect(p.x).toBeCloseTo(NODE_BOX.w / 2, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it('正下方向：交点在下边缘，且**不**是斜对角（这就是固定半径近似会错的地方）', () => {
    const p = rectEdgePoint(0, 0, 0, 100);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(NODE_BOX.h / 2, 6);
  });

  it('斜向：交点必在矩形边界上（|x|/a 与 |y|/b 中至少一个取到 1）', () => {
    const p = rectEdgePoint(10, 20, 310, 220);
    const u = Math.abs(p.x - 10) / (NODE_BOX.w / 2);
    const v = Math.abs(p.y - 20) / (NODE_BOX.h / 2);
    expect(Math.max(u, v)).toBeCloseTo(1, 6);
    expect(Math.min(u, v)).toBeLessThanOrEqual(1.000001);
  });

  it('目标与中心重合：原样返回中心（不产生 NaN）', () => {
    const p = rectEdgePoint(5, 5, 5, 5);
    expect(p).toEqual({ x: 5, y: 5 });
    expect(Number.isNaN(p.x)).toBe(false);
  });
});

describe('clipLabel —— 标签截断', () => {
  it('不超长原样返回（并去掉首尾空白）', () => {
    expect(clipLabel(' 闭包 ')).toBe('闭包');
  });

  it('超长截断并加省略号', () => {
    expect(clipLabel('一二三四五六七八九十', 4)).toBe('一二三四…');
  });
});

describe('layoutNeighborhood —— 分层与摆位', () => {
  it('中心节点在圆心，跳数为 0，环半径为 0', () => {
    const l = layoutNeighborhood(nb('c', ['a'], [edge('c', 'a')]));
    const center = l.nodes.find((n) => n.node.id === 'c')!;
    expect(center.x).toBeCloseTo(GRAPH_VIEW.w / 2, 6);
    expect(center.y).toBeCloseTo(GRAPH_VIEW.h / 2, 6);
    expect(center.depth).toBe(0);
    expect(center.ring).toBe(0);
  });

  it('一跳节点落在同一个环上、且彼此不重合', () => {
    const l = layoutNeighborhood(
      nb('c', ['a', 'b', 'd'], [edge('c', 'a'), edge('c', 'b'), edge('c', 'd')]),
    );
    const ring1 = l.nodes.filter((n) => n.depth === 1);
    expect(ring1).toHaveLength(3);
    expect(new Set(ring1.map((n) => n.ring)).size).toBe(1);
    const keys = new Set(ring1.map((n) => `${Math.round(n.x)},${Math.round(n.y)}`));
    expect(keys.size).toBe(3);
  });

  it('★ 二跳节点落在其父的角度扇区内，不飘到对面分支', () => {
    // c → a、c → b；a → a1。a1 应当离 a 更近，而不是跑到与它无关的 b 那边
    const l = layoutNeighborhood(nb('c', ['a', 'b', 'a1'], [edge('c', 'a'), edge('c', 'b'), edge('a', 'a1')]));
    const cx = GRAPH_VIEW.w / 2;
    const cy = GRAPH_VIEW.h / 2;
    const a = l.nodes.find((n) => n.node.id === 'a')!;
    const b = l.nodes.find((n) => n.node.id === 'b')!;
    const a1 = l.nodes.find((n) => n.node.id === 'a1')!;
    expect(a1.depth).toBe(2);
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    expect(dist(a1, a)).toBeLessThan(dist(a1, b));
    expect(a1.ring).toBeGreaterThan(a.ring);
    // 仍在画布语义内（以圆心为中心的环，不该跑到画布对角外）
    expect(Math.hypot(a1.x - cx, a1.y - cy)).toBeCloseTo(a1.ring, 6);
  });

  it('★ 同一份数据两次布局结果完全一致（图不许自己转角度）', () => {
    const data = nb('c', ['a', 'b', 'a1', 'b1'], [edge('c', 'a'), edge('c', 'b'), edge('a', 'a1'), edge('b', 'b1')]);
    const l1 = layoutNeighborhood(data);
    const l2 = layoutNeighborhood(data);
    const key = (l: typeof l1) =>
      l.nodes
        .map((n) => `${n.node.id}:${n.x.toFixed(3)},${n.y.toFixed(3)}`)
        .sort()
        .join('|');
    expect(key(l1)).toBe(key(l2));
  });

  it('同层角序按节点 id 排序，与入参数组顺序无关', () => {
    const e = [edge('c', 'a'), edge('c', 'b')];
    const l1 = layoutNeighborhood({ ...nb('c', ['a', 'b'], e) });
    const l2 = layoutNeighborhood({ ...nb('c', ['b', 'a'], e) });
    const pos = (l: typeof l1, id: string) => {
      const n = l.nodes.find((x) => x.node.id === id)!;
      return [n.x, n.y];
    };
    expect(pos(l1, 'a')).toEqual(pos(l2, 'a'));
  });

  it('孤立节点（无任何边）不丢：落到一环且被算作 depth 1', () => {
    const l = layoutNeighborhood(nb('c', ['solo'], []));
    const solo = l.nodes.find((n) => n.node.id === 'solo');
    expect(solo).toBeDefined();
    expect(solo!.depth).toBe(1);
    expect(solo!.ring).toBeGreaterThan(0);
  });

  it('边连到邻域外的节点：跳过该边而不是崩（深度截断的正常结果）', () => {
    const l = layoutNeighborhood(nb('c', ['a'], [edge('c', 'a'), edge('a', 'outside')]));
    expect(l.edges).toHaveLength(1);
    const only = l.edges[0];
    expect(only?.edge.id).toBe('c->a');
  });

  it('边的端点落在两端卡片外沿（不与卡片中心重合）', () => {
    const l = layoutNeighborhood(nb('c', ['a'], [edge('c', 'a')]));
    const e0 = l.edges[0]!;
    const c = l.nodes.find((n) => n.node.id === 'c')!;
    const a = l.nodes.find((n) => n.node.id === 'a')!;
    expect(Math.hypot(e0.x1 - c.x, e0.y1 - c.y)).toBeGreaterThan(NODE_BOX.h / 2 - 1);
    expect(Math.hypot(e0.x2 - a.x, e0.y2 - a.y)).toBeGreaterThan(NODE_BOX.h / 2 - 1);
  });

  it('环半径清单与 maxDepth 一致，且不含中心的 0 环', () => {
    const l = layoutNeighborhood(nb('c', ['a', 'a1'], [edge('c', 'a'), edge('a', 'a1')]));
    expect(l.maxDepth).toBe(2);
    expect(l.rings).toHaveLength(2);
    expect(l.rings.every((r) => r > 0)).toBe(true);
    expect(l.rings[0]!).toBeLessThan(l.rings[1]!);
  });
});

describe('语义文案与视觉分档', () => {
  it('四种节点类型各有中文名', () => {
    expect(nodeKindLabel('term')).toBe('词条');
    expect(nodeKindLabel('note')).toBe('错题笔记');
    expect(nodeKindLabel('turn')).toBe('对话轮次');
    expect(nodeKindLabel('concept')).toBe('概念');
  });

  it('四种边类型各有中文名', () => {
    expect(edgeKindLabel('prereq')).toBe('前置');
    expect(edgeKindLabel('relates')).toBe('相关');
    expect(edgeKindLabel('derived_from')).toBe('由…引发');
    expect(edgeKindLabel('contains')).toBe('从属');
  });

  it('★ 三种 origin 的 class 与文案两两不同（AI 边不许长得像用户确认边）', () => {
    const cls = new Set([edgeClass('user'), edgeClass('ai'), edgeClass('derived')]);
    expect(cls.size).toBe(3);
    const labels = new Set([edgeOriginLabel('user'), edgeOriginLabel('ai'), edgeOriginLabel('derived')]);
    expect(labels.size).toBe(3);
    expect(edgeOriginLabel('ai')).toContain('未经确认');
  });

  it('中心节点带 center 类（视觉上要与普通节点分得开）', () => {
    expect(nodeClass(node('a', 'term'), true)).toContain('center');
    expect(nodeClass(node('a', 'term'), false)).not.toContain('center');
    expect(nodeClass(node('a', 'note'), false)).toContain('note');
  });

  it('★ derived 边不提供单边删除（走批量撤销，混成一个会让用户以为删干净了）', () => {
    expect(canRemoveEdge('user')).toBe(true);
    expect(canRemoveEdge('ai')).toBe(true);
    expect(canRemoveEdge('derived')).toBe(false);
  });
});
