/**
 * KnowledgeGraphPage — 知识数据图页面（契约 docs/STUDY-FLOW-SPEC.md §3 / §4）。
 *
 * 页面结构 = 「概览 → 选节点 → 看它的关系」三步，对应老板的三个诉求：
 *   ① 一览**学出来的东西有多少**（统计：节点数/边数，按类型与出处分）；
 *   ② **点任意节点**即以它为中心画出邻域子图（`NeighborhoodGraph`）；
 *   ③ 看**节点内的词条/错题笔记及其关系**，并能手工连边、删边（`NodeDetailCard`）。
 *
 * ★ 删边的两个出口刻意分开：
 *   · 单条 → 在详情卡里删（只对 `user` / `ai` 边的单条有效）；
 *   · `derived` 结构推导边 → 只能整批「清理自动关系」，因为那些边是**规则重算出来的**，
 *     单删了下次重算又会冒出来，让用户以为自己删过。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KnowledgeEdgeKind, KnowledgeGraphStats, KnowledgeNeighborhood, KnowledgeNode, KnowledgeNodeKind } from '@sb/shared';
import { api, ApiError } from '../../lib/api';
import { PlusIcon, SearchIcon } from '../../components/icons';
import { NeighborhoodGraph } from './NeighborhoodGraph';
import { NodeDetailCard } from './NodeDetailCard';
import { nodeKindLabel } from './graph-visual';
import './graph.css';

const KIND_TABS: Array<{ key: KnowledgeNodeKind | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'term', label: '词条' },
  { key: 'note', label: '错题笔记' },
  { key: 'turn', label: '对话轮次' },
  { key: 'concept', label: '概念' },
];

export function KnowledgeGraphPage({ onOpenTerms }: { onOpenTerms?: (keyword: string) => void }) {
  const [stats, setStats] = useState<KnowledgeGraphStats | null>(null);
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [kindFilter, setKindFilter] = useState<KnowledgeNodeKind | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nb, setNb] = useState<KnowledgeNeighborhood | null>(null);
  /** 邻域深度（跳数）。默认 2：一跳常常只有一个邻居，看不出结构 */
  const [depth, setDepth] = useState(2);
  const [newName, setNewName] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const flash = (m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(''), 2600);
  };

  const reloadList = useCallback(async () => {
    const [s, n] = await Promise.all([
      api.studyFlow.graphStats(),
      api.studyFlow.graphNodes(kindFilter === 'all' ? undefined : kindFilter),
    ]);
    setStats(s);
    setNodes(n);
  }, [kindFilter]);

  useEffect(() => {
    void reloadList().catch(() => undefined);
  }, [reloadList]);

  const loadNb = useCallback(async (id: string) => {
    setNb(await api.studyFlow.neighborhood(id, depth));
  }, [depth]);

  // 列表变了但还没选中任何节点时，自动选第一个（空页面比"有东西但要自己找"更让人困惑）
  useEffect(() => {
    const first = nodes[0];
    if (!selectedId && first) setSelectedId(first.id);
  }, [nodes, selectedId]);

  useEffect(() => {
    if (selectedId) void loadNb(selectedId).catch(() => setNb(null));
  }, [selectedId, loadNb]);

  const visible = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return q ? nodes.filter((n) => n.refText.toLowerCase().includes(q)) : nodes;
  }, [nodes, keyword]);

  const selected = nodes.find((n) => n.id === selectedId) ?? nb?.center ?? null;

  const addEdge = async (input: { fromNodeId: string; toNodeId: string; kind: KnowledgeEdgeKind; evidence?: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.studyFlow.addEdge(input);
      flash('已建立关系（记为「已确认」）');
      if (selectedId) await loadNb(selectedId);
      await reloadList();
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '建立关系失败');
    } finally {
      setBusy(false);
    }
  };

  const removeEdge = async (edgeId: string) => {
    try {
      await api.studyFlow.removeEdge(edgeId);
      flash('已删除该关系');
      if (selectedId) await loadNb(selectedId);
      await reloadList();
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '删除失败');
    }
  };

  const purgeDerived = async () => {
    try {
      const r = await api.studyFlow.purgeDerived();
      flash(r.removed > 0 ? `已清理 ${r.removed} 条自动关系` : '没有可清理的自动关系');
      if (selectedId) await loadNb(selectedId);
      await reloadList();
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '清理失败');
    }
  };

  const addNode = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const n = await api.studyFlow.addNode({ kind: 'concept', refText: name });
      setNewName('');
      setSelectedId(n.id);
      flash('已登记概念节点');
      await reloadList();
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '登记失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gr-page">
      <div className="gr-page-head">
        <h2>知识图</h2>
        <span className="gr-page-sub">
          学习流按你编排的方式产出的词条、错题笔记与它们的相互关系。点任一节点可以顺着关系走下去。
        </span>
      </div>

      {stats && (
        <div className="gr-stats">
          <span className="gr-stat">
            <b>{stats.nodes}</b> 节点
          </span>
          <span className="gr-stat">
            <b>{stats.edges}</b> 条关系
          </span>
          {stats.byOrigin.map((o) => (
            <span key={o.origin} className={`gr-stat ${o.origin}`}>
              {o.origin === 'user' ? '已确认' : o.origin === 'ai' ? 'AI 抽取' : '自动推导'} <b>{o.count}</b>
            </span>
          ))}
          <button className="gr-btn" onClick={() => void purgeDerived()}>
            清理自动关系
          </button>
        </div>
      )}

      <div className="gr-toolbar">
        <div className="gr-tabs" role="tablist">
          {KIND_TABS.map((t) => (
            <button
              key={t.key}
              className={kindFilter === t.key ? 'gr-tab on' : 'gr-tab'}
              onClick={() => setKindFilter(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="gr-search">
          <SearchIcon size={14} />
          <input placeholder="搜节点…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <label className="gr-depth">
          关系深度
          <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
            <option value={1}>1 跳</option>
            <option value={2}>2 跳</option>
          </select>
        </label>
      </div>

      <div className="gr-body">
        <div className="gr-list">
          {visible.length === 0 && (
            <div className="gr-empty">
              <p>{keyword || kindFilter !== 'all' ? '没有匹配的节点' : '知识图还是空的'}</p>
              <p className="gr-empty-sub">
                跑一次学习流（在「学习流」页），讲过的词条与错过的题会自动变成这里的节点。
              </p>
            </div>
          )}
          {visible.slice(0, 300).map((n) => (
            <button
              key={n.id}
              className={n.id === selectedId ? 'gr-item on' : 'gr-item'}
              onClick={() => setSelectedId(n.id)}
            >
              <span className={`gr-kind-badge ${n.kind}`}>{nodeKindLabel(n.kind)}</span>
              <span className="gr-item-name">{n.refText}</span>
            </button>
          ))}
          {visible.length > 300 && <div className="gr-list-more">只列出前 300 个，用搜索缩小范围</div>}
        </div>

        <div className="gr-main">
          {nb ? (
            <NeighborhoodGraph nb={nb} maxDepth={depth} onPickNode={(id) => setSelectedId(id)} />
          ) : (
            <div className="gr-empty gr-empty-canvas">
              <p>选一个节点看它的关系</p>
            </div>
          )}

          {selected && (
            <NodeDetailCard
              node={selected}
              nb={nb ?? { center: selected, nodes: [selected], edges: [], truncated: false }}
              allNodes={nodes}
              onAddEdge={(i) => void addEdge(i)}
              onRemoveEdge={(id) => void removeEdge(id)}
              {...(onOpenTerms ? { onOpenSource: (n: KnowledgeNode) => onOpenTerms(n.refText) } : {})}
            />
          )}
        </div>
      </div>

      <div className="gr-add-node">
        <div className="gr-rel-head">手工登记一个概念节点</div>
        <div className="gr-add-row">
          <input
            placeholder="概念名（如：动名词的完成式）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addNode()}
          />
          <button className="gr-btn primary" disabled={busy || !newName.trim()} onClick={() => void addNode()}>
            <PlusIcon size={14} /> 登记
          </button>
        </div>
        <p className="gr-add-hint">词条与错题笔记由学习流自动产出；这里适合记一个还没有出处的概念。</p>
      </div>

      {msg && <div className="gr-msg">{msg}</div>}
    </div>
  );
}
