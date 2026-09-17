/**
 * NodeDetailCard — 单个知识节点的**详情与关系管理**（契约 docs/STUDY-FLOW-SPEC.md §3 / §4）。
 *
 * 老板的原始诉求落在这里：「点击任意节点，能看到节点内的词条/错题笔记，以及它与其他词条的关系」。
 * 故本卡片的四块内容一一对应：
 *  ① **这个节点是什么**——类型 + 快照文本 + 引用来源（哪次运行产出的）；
 *  ② **它指向谁**（出边）、**谁指向它**（入边）——分开列，因为方向本身携带语义（前置/引发…）；
 *  ③ **手工连一条边**——用户确定的关系是最高可信档（`origin='user'`，由服务端强制，前端不能自报）；
 *  ④ **删边**——`derived` 结构推导边不给单删（那是批量撤销的事，见 `canRemoveEdge` 的注释）。
 *
 * ★ 为什么正文不在这里：知识图只存**引用 + 抗删快照**（`refId` + `refText`），
 *   正文在词条库/笔记页各自的表里。所以这里给一个「去词条库看正文」的出口而不是复制一份正文
 *   ——复制就会有两份会各自过期的真相。
 */
import { useState } from 'react';
import type { KnowledgeEdge, KnowledgeEdgeKind, KnowledgeNeighborhood, KnowledgeNode } from '@sb/shared';
import { canRemoveEdge, edgeKindLabel, edgeOriginLabel, nodeKindLabel } from './graph-visual';

/** 可选的关系类型（与 `KnowledgeEdgeKind` 同源，中文名走 `edgeKindLabel`） */
const EDGE_KINDS: KnowledgeEdgeKind[] = ['prereq', 'relates', 'derived_from', 'contains'];

export function NodeDetailCard({
  node,
  nb,
  allNodes,
  onAddEdge,
  onRemoveEdge,
  onOpenSource,
}: {
  node: KnowledgeNode;
  /** 当前邻域（出/入边从这里取——邻域返回的边就是与该节点相关的全部可见边） */
  nb: KnowledgeNeighborhood;
  /** 加边时的候选目标（一般给全部节点，排除自己） */
  allNodes: KnowledgeNode[];
  onAddEdge: (input: { fromNodeId: string; toNodeId: string; kind: KnowledgeEdgeKind; evidence?: string }) => void;
  onRemoveEdge: (edgeId: string) => void;
  /** 有正文可看时给个出口（词条 → 词条库）；不传则不显示按钮 */
  onOpenSource?: (node: KnowledgeNode) => void;
}) {
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<KnowledgeEdgeKind>('relates');
  const [evidence, setEvidence] = useState('');

  const nameOf = (id: string) => {
    if (id === node.id) return node.refText;
    return allNodes.find((n) => n.id === id)?.refText ?? nb.nodes.find((n) => n.id === id)?.refText ?? id;
  };

  const out = nb.edges.filter((e) => e.fromNodeId === node.id);
  const income = nb.edges.filter((e) => e.toNodeId === node.id);
  const candidates = allNodes.filter((n) => n.id !== node.id);

  const submitEdge = () => {
    if (!target) return;
    onAddEdge({ fromNodeId: node.id, toNodeId: target, kind, ...(evidence.trim() ? { evidence: evidence.trim() } : {}) });
    setTarget('');
    setEvidence('');
  };

  const renderEdge = (e: KnowledgeEdge, dir: 'out' | 'in') => (
    <li key={e.id} className={`gr-rel ${e.origin}`}>
      <span className="gr-rel-dir">{dir === 'out' ? '→' : '←'}</span>
      <span className="gr-rel-name">{nameOf(dir === 'out' ? e.toNodeId : e.fromNodeId)}</span>
      <span className="gr-rel-kind">{edgeKindLabel(e.kind)}</span>
      <span className="gr-rel-origin" title={e.evidence ?? ''}>
        {edgeOriginLabel(e.origin)}
      </span>
      {canRemoveEdge(e.origin) ? (
        <button className="gr-rel-del" title="删除这条关系" onClick={() => onRemoveEdge(e.id)}>
          ×
        </button>
      ) : (
        <span className="gr-rel-locked" title="结构推导的边由系统重算，请用「清理自动关系」批量撤销">
          自动
        </span>
      )}
    </li>
  );

  return (
    <div className="gr-detail">
      <div className="gr-detail-head">
        <span className={`gr-kind-badge ${node.kind}`}>{nodeKindLabel(node.kind)}</span>
        <h3 className="gr-detail-name">{node.refText}</h3>
      </div>

      <div className="gr-detail-meta">
        {node.sourceRunId ? <span>由一次学习流产出</span> : <span>手工登记</span>}
        {node.sourceStepId && <span className="gr-detail-step">步骤 {node.sourceStepId.slice(0, 8)}</span>}
        <span>{node.createdAt.slice(0, 10)}</span>
      </div>

      {!node.refId && <p className="gr-detail-note">这是手工登记的「概念」节点，不指向词条或笔记。</p>}
      {onOpenSource && node.refId && (node.kind === 'term' || node.kind === 'note') && (
        <button className="gr-btn" onClick={() => onOpenSource(node)}>
          去{node.kind === 'term' ? '词条库' : '笔记页'}看正文
        </button>
      )}

      <div className="gr-rel-block">
        <div className="gr-rel-head">它指向的（{out.length}）</div>
        {out.length === 0 ? (
          <p className="gr-rel-empty">还没有关系</p>
        ) : (
          <ul className="gr-rel-list">{out.map((e) => renderEdge(e, 'out'))}</ul>
        )}
      </div>

      <div className="gr-rel-block">
        <div className="gr-rel-head">指向它的（{income.length}）</div>
        {income.length === 0 ? (
          <p className="gr-rel-empty">还没有关系</p>
        ) : (
          <ul className="gr-rel-list">{income.map((e) => renderEdge(e, 'in'))}</ul>
        )}
      </div>

      <div className="gr-add-edge">
        <div className="gr-rel-head">手工连一条关系</div>
        <div className="gr-add-row">
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="目标节点">
            <option value="">选一个节点…</option>
            {candidates.map((n) => (
              <option key={n.id} value={n.id}>
                {n.refText}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as KnowledgeEdgeKind)}
            aria-label="关系类型"
          >
            {EDGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {edgeKindLabel(k)}
              </option>
            ))}
          </select>
        </div>
        <input
          className="gr-add-evidence"
          placeholder="依据（可留空，如：错在这一步）"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
        <button className="gr-btn primary" disabled={!target} onClick={submitEdge}>
          建立关系
        </button>
        <p className="gr-add-hint">你手工连的关系记为「已确认」，与 AI 抽取的区分显示。</p>
      </div>
    </div>
  );
}
