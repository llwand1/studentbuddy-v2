/**
 * graph-demo.test — 落地页知识图演示的**帧逻辑与几何**锁（2026-09-20 知识图演示批）。
 *
 * ★ 为什么这些必须单测而不是靠看图：
 *   ① **几何落框**：演示窗等比缩放会把越界悄悄裁掉。真机表现是"某个词条不见了"，
 *      而人只会以为"演示还没走到那一帧"——极难归因。
 *   ② **卡片不重叠**：两张卡片叠一起，看着像"一个节点"，读者会数错星型的边数。
 *   ③ **抽词清单与节点一致**：提示说抽到 A、图上却连出 B ⇒ 观者会当场怀疑图是假的。
 *      这类错位不会报错、不会崩，只有交叉断言拦得住。
 *   ④ **帧只控制显现、不重算布局**：若有人把 `GRAPH_DEMO_LAYOUT` 改回函数并按帧调用，
 *      节点会在帧间飞位（观感像抽搐）。"两次布局结果全等"这条断言把该约定钉死。
 */
import { describe, it, expect } from 'vitest';
import {
  DEMO_CENTER,
  DEMO_DEEP,
  DEMO_REPLY_TERMS,
  FRAME,
  GRAPH_DEMO_LAYOUT,
  GRAPH_DEMO_NEIGHBORHOOD,
  GRAPH_DEMO_OPTS,
  GRAPH_DEMO_VIEW,
  CONFIRMED_EDGE_ID,
  edgeOriginAt,
  edgeVisibleAt,
  nodeVisibleAt,
} from './graph-demo';
import { layoutNeighborhood } from '../../features/study-flow/graph-visual';

const box = GRAPH_DEMO_OPTS.box;

/** 某帧该显现的节点（中心恒在） */
const nodesAt = (stage: number) => GRAPH_DEMO_LAYOUT.nodes.filter((n) => nodeVisibleAt(n.node, stage));
const edgesAt = (stage: number) => GRAPH_DEMO_LAYOUT.edges.filter((e) => edgeVisibleAt(e.edge, stage));

describe('知识图演示 — 几何落框', () => {
  it('每个节点卡片都完整落在演示画布内（越界会被等比缩放悄悄裁掉）', () => {
    expect(GRAPH_DEMO_LAYOUT.nodes.length).toBeGreaterThan(0);
    for (const n of GRAPH_DEMO_LAYOUT.nodes) {
      expect(n.x - box.w / 2, `${n.node.refText} 左边越界`).toBeGreaterThanOrEqual(0);
      expect(n.x + box.w / 2, `${n.node.refText} 右边越界`).toBeLessThanOrEqual(GRAPH_DEMO_VIEW.w);
      expect(n.y - box.h / 2, `${n.node.refText} 上边越界`).toBeGreaterThanOrEqual(0);
      expect(n.y + box.h / 2, `${n.node.refText} 下边越界`).toBeLessThanOrEqual(GRAPH_DEMO_VIEW.h);
    }
  });

  it('任意两张卡片不相交（叠在一起会被看成"一个节点"，星型的边数就数错了）', () => {
    const ns = GRAPH_DEMO_LAYOUT.nodes;
    for (let i = 0; i < ns.length; i += 1) {
      for (let j = i + 1; j < ns.length; j += 1) {
        const dx = Math.abs(ns[i]!.x - ns[j]!.x);
        const dy = Math.abs(ns[i]!.y - ns[j]!.y);
        // 轴对齐矩形不相交 ⇔ 至少一个轴上分离
        const apart = dx >= box.w || dy >= box.h;
        expect(apart, `「${ns[i]!.node.refText}」与「${ns[j]!.node.refText}」卡片重叠`).toBe(true);
      }
    }
  });

  it('两条环（一跳 / 二跳各一环）——少画一环就看不出"几跳"这件事', () => {
    expect(GRAPH_DEMO_LAYOUT.rings).toEqual([GRAPH_DEMO_OPTS.ringR1, GRAPH_DEMO_OPTS.ringR1 + GRAPH_DEMO_OPTS.ringStep]);
    expect(GRAPH_DEMO_LAYOUT.maxDepth).toBe(2);
  });

  it('★ 一跳环半径要显著大于卡片宽——缝隙太窄会让中心与左右两张卡片看起来连成一片', () => {
    // 这条来自**真机目检**：`ringR1` 取 100 时缝只剩 8px，三张卡片在截图里糊成一条；
    // 而当时"卡片互不重叠"那条断言是**全绿**的——它只保证不相交，不保证不挤。
    // 单测能兜住下限，观感得靠探针截图 + 人眼，这条只是把下限抬到观感可接受的位置。
    const gap = GRAPH_DEMO_OPTS.ringR1 - GRAPH_DEMO_OPTS.box.w;
    expect(gap, `缝隙仅 ${gap}px，三张卡片会看起来连成一片`).toBeGreaterThanOrEqual(16);
  });

  it('★ 布局与帧无关：同一份数据算两次结果全等（否则节点会在帧间飞位）', () => {
    const again = layoutNeighborhood(GRAPH_DEMO_NEIGHBORHOOD, GRAPH_DEMO_VIEW, GRAPH_DEMO_OPTS);
    expect(again.nodes.map((n) => [n.node.id, n.x, n.y])).toEqual(GRAPH_DEMO_LAYOUT.nodes.map((n) => [n.node.id, n.x, n.y]));
    expect(again.edges.map((e) => [e.edge.id, e.x1, e.y1, e.x2, e.y2])).toEqual(
      GRAPH_DEMO_LAYOUT.edges.map((e) => [e.edge.id, e.x1, e.y1, e.x2, e.y2]),
    );
  });
});

describe('知识图演示 — 帧 → 显现', () => {
  it('中心节点恒在（它是整张图的锚，任何一帧都不能少）', () => {
    for (let s = 0; s <= FRAME.origin; s += 1) {
      expect(nodeVisibleAt(DEMO_CENTER, s), `第 ${s} 帧中心不见了`).toBe(true);
    }
  });

  it('节点数逐帧只增不减：2 → 2 → 5 → 7（含中心）', () => {
    expect(nodesAt(FRAME.first).length).toBe(2);
    expect(nodesAt(FRAME.ask).length).toBe(2); // 帧 1 只多一个"追问"按钮，不加节点
    expect(nodesAt(FRAME.star).length).toBe(5);
    expect(nodesAt(FRAME.tree).length).toBe(7);
    expect(nodesAt(FRAME.origin).length).toBe(7); // 末帧讲出处，不加节点
  });

  it('边数逐帧：1 → 1 → 4 → 6 → 6', () => {
    expect(edgesAt(FRAME.first).length).toBe(1);
    expect(edgesAt(FRAME.ask).length).toBe(1);
    expect(edgesAt(FRAME.star).length).toBe(4);
    expect(edgesAt(FRAME.tree).length).toBe(6);
    expect(edgesAt(FRAME.origin).length).toBe(6);
  });

  it('帧 0 就有一条「已确认」的实线——没有它，末帧讲出处时就没有对照物', () => {
    const first = edgesAt(FRAME.origin).filter((e) => e.edge.origin === 'user');
    expect(first.length).toBe(1);
  });

  it('★ 追问连出来的边清一色是 ai（等于把「追问连接线」的口径钉在测试里）', () => {
    const ai = edgesAt(FRAME.origin).filter((e) => e.edge.origin === 'ai');
    expect(ai.length).toBe(5);
    // 追问连的边都带原话摘录（契约：ai 边存 evidence），不许是空串
    for (const e of ai) expect(e.edge.evidence).toBeTruthy();
  });
});

describe('知识图演示 — 末帧「确认转正」', () => {
  const confirmed = GRAPH_DEMO_LAYOUT.edges.find((e) => e.edge.id === CONFIRMED_EDGE_ID)!;

  it('转正的那条边存在，且初始确实是 ai（否则末帧的"转正"演不出来）', () => {
    expect(confirmed).toBeTruthy();
    expect(confirmed.edge.origin).toBe('ai');
    expect(edgeOriginAt(confirmed.edge, FRAME.first)).toBe('ai');
    expect(edgeOriginAt(confirmed.edge, FRAME.tree)).toBe('ai');
  });

  it('★ 到末帧才变成 user（早一帧变就与解说词脱节）', () => {
    expect(edgeOriginAt(confirmed.edge, FRAME.origin)).toBe('user');
  });

  it('转正只改 origin、不改 kind（"关系成立"与"关系类型"是两个独立动作）', () => {
    expect(confirmed.edge.kind).toBe('relates');
  });

  it('其他边任何时候都不受影响', () => {
    for (const e of GRAPH_DEMO_LAYOUT.edges) {
      if (e.edge.id === CONFIRMED_EDGE_ID) continue;
      for (let s = 0; s <= FRAME.origin; s += 1) expect(edgeOriginAt(e.edge, s)).toBe(e.edge.origin);
    }
  });
});

describe('知识图演示 — 抽词清单与图上节点必须逐字一致', () => {
  it('帧 2 的抽词清单 === 该帧新增的节点名（顺序无关）', () => {
    const added = GRAPH_DEMO_LAYOUT.nodes.filter((n) => !nodeVisibleAt(n.node, FRAME.ask) && nodeVisibleAt(n.node, FRAME.star));
    expect([...added.map((n) => n.node.refText)].sort()).toEqual([...DEMO_REPLY_TERMS].sort());
  });

  it('帧 3 的抽词清单 === 该帧新增的节点名，且父节点就是提示里那个词条', () => {
    const added = GRAPH_DEMO_LAYOUT.nodes.filter((n) => !nodeVisibleAt(n.node, FRAME.star) && nodeVisibleAt(n.node, FRAME.tree));
    expect([...added.map((n) => n.node.refText)].sort()).toEqual([...DEMO_DEEP.terms].sort());
    // 提示说"对「学习率」再追一层"⇒ 图上也必须是从「学习率」连出去的
    const parent = GRAPH_DEMO_LAYOUT.nodes.find((n) => n.node.refText === DEMO_DEEP.term)!;
    const kids = GRAPH_DEMO_LAYOUT.edges.filter((e) => edgeVisibleAt(e.edge, FRAME.tree) && !edgeVisibleAt(e.edge, FRAME.star));
    for (const e of kids) expect([e.edge.fromNodeId, e.edge.toNodeId]).toContain(parent.node.id);
  });
});
