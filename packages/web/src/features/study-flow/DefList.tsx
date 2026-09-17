/**
 * DefList — 学习流**定义列表**（左侧栏）。契约 docs/STUDY-FLOW-SPEC.md §2.3。
 *
 * ★ 「克隆」是本栏最常用的动作，理由值得写下来：学习流的价值在于「把一次有效的学习过程固定下来、
 *   反复复用」，而用户调好一条流之后更常见的是**在它的基础上改一版**（换主题、加一步复盘），
 *   而不是从空白新建。所以克隆给的是**独立副本**——跑过的运行不受影响（各有自己的定义快照）。
 *
 * ★ 「新建」不再是**一键建空壳**（2026-09-17 老板实测反馈）：点开先**选模板**
 *   （对齐 Dify 的「从模板创建」）。原来的一键新建给的是一条"必填空着的讲解步骤"，
 *   用户进去第一眼就是缺参数、一保存就被拒——那是**起点给错了**，不是校验错了。
 */
import { useState } from 'react';
import type { FlowDef } from '@sb/shared';
import { TemplatePicker } from './TemplatePicker';

export function DefList({
  defs,
  currentId,
  busy,
  onPick,
  onCreate,
  onClone,
  onRemove,
}: {
  defs: FlowDef[];
  currentId: string | null;
  busy: boolean;
  onPick: (id: string) => void;
  /** 用哪个模板新建（模板 key 见 flow-templates.ts） */
  onCreate: (templateKey: string) => void;
  onClone: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [picking, setPicking] = useState(false);

  return (
    <div className="fl-defs">
      <div className="fl-defs-head">
        <span>我的学习流</span>
        <button className="fl-btn" disabled={busy} onClick={() => setPicking((v) => !v)}>
          {picking ? '取消' : '新建'}
        </button>
      </div>

      {picking && (
        <TemplatePicker
          busy={busy}
          onClose={() => setPicking(false)}
          onPick={(key) => {
            setPicking(false);
            onCreate(key);
          }}
        />
      )}

      <div className="fl-defs-list">
        {defs.length === 0 && !picking && (
          <p className="fl-panel-hint">
            还没有学习流。点上面的「新建」挑一个模板——模板已经把「讲解 → 出题 → 判分 → 复盘」
            这样的顺序、参数示例和连线都配好了，新建出来就能直接跑，再按自己的主题改。
          </p>
        )}
        {defs.map((d) => (
          <div key={d.id} className={d.id === currentId ? 'fl-def on' : 'fl-def'}>
            <button className="fl-def-main" onClick={() => onPick(d.id)}>
              <span className="fl-def-name">{d.name}</span>
              <span className="fl-def-meta">
                {d.steps.length} 步 · v{d.version}
              </span>
            </button>
            <div className="fl-def-acts">
              <button className="fl-mini" title="克隆成一条新流" disabled={busy} onClick={() => onClone(d.id)}>
                克隆
              </button>
              <button className="fl-mini danger" title="删除这条流（跑过的运行会保留）" disabled={busy} onClick={() => onRemove(d.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
