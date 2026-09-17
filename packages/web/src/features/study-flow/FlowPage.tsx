/**
 * FlowPage — 学习流页面（契约 docs/STUDY-FLOW-SPEC.md §2 / §6）。
 *
 * 这一页把老板那句「把学习过程控制流化、让每次学习流程被固定化」落成可见的东西：
 *   左：我的学习流（可新建/克隆/删除） → 中：编排画布 → 右：步骤参数与出口 → 下：运行与轨迹。
 *
 * ★ 页面层独有的三件事（子组件都不管）：
 *  ① **草稿态**：所有编辑先改本地 `draft`，点「保存」才整份提交（`updateDef` 是整体替换语义，契约 §2.3）。
 *     有未保存改动时**禁止开跑**——运行冻结的是库里那一版，不然用户会以为"我改了它却不按我改的跑"。
 *  ② **保存前用 shared 的校验逐步骤过一遍**（与服务端执行期同一份代码，把错误挡在配置期）；
 *     出错**自动跳到那一步**——只 flash 一句「缺少必填参数」，用户还得自己在画布上找是哪一步。
 *  ③ **删步骤时连带删它的边**：服务端对悬空边直接 400（"悬空边会让运行器找不到下一步"）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowDef, FlowStepKind, FlowPort } from '@sb/shared';
import { api, ApiError } from '../../lib/api';
import type { FlowStepMetaWired } from '../../lib/api-study-flow';
import { DefList } from './DefList';
import { FlowCanvas } from './FlowCanvas';
import { StepPanel } from './StepPanel';
import { RunPanel } from './RunPanel';
import { cloneDef as cloneFlow, createNewDef, newStepId, removeDef, saveDef } from './flow-actions';
import { collectParamProblems, initStepParams } from './flow-form';
import { runBlockReason } from './run-status';
import { nextFreeCenter, type Point } from './flow-layout';
import './flow.css';

export function FlowPage({ onGoGraph }: { onGoGraph?: () => void }) {
  const [metas, setMetas] = useState<FlowStepMetaWired[]>([]);
  const [defs, setDefs] = useState<FlowDef[]>([]);
  const [defId, setDefId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FlowDef | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selStep, setSelStep] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  /** 本地新增边的临时 id 序号（服务端不接收边 id，保存时只提交两端与端口） */
  const edgeSeq = useRef(0);

  // 顶部一行提示，2.8s 自隐（成功与失败共用；本页一次只有一件事，不做 toast 栈）
  const flash = useCallback((m: string) => { setMsg(m); window.setTimeout(() => setMsg(''), 2800); }, []);

  const reloadDefs = useCallback(async () => {
    try {
      setDefs(await api.studyFlow.listDefs());
    } catch {
      setDefs([]);
    }
  }, []);

  useEffect(() => {
    void api.studyFlow
      .steps()
      .then((r) => setMetas(r.steps))
      .catch(() => setMetas([]));
    void reloadDefs();
  }, [reloadDefs]);

  // 选中一条流 → 拉完整定义做草稿副本（**副本**：编辑不该在用户点保存前影响库里的那份）
  useEffect(() => {
    if (!defId) {
      setDraft(null);
      return;
    }
    let alive = true;
    void api.studyFlow
      .getDef(defId)
      .then((d) => {
        if (!alive) return;
        setDraft(structuredClone(d));
        setDirty(false);
        setSelStep(d.steps[0]?.id ?? null);
      })
      .catch(() => {
        if (alive) setDraft(null);
      });
    return () => {
      alive = false;
    };
  }, [defId]);

  const wiredSet = useMemo(() => new Set(metas.filter((m) => m.wired).map((m) => m.kind)), [metas]);

  // 草稿参数问题（与保存、服务端执行期同一份校验）→ 该不该拦住开跑（理由与定位在 run-status）
  const paramProblems = useMemo(() => (draft ? collectParamProblems(draft.steps) : []), [draft]);
  const runBlock = useMemo(() => runBlockReason({ dirty, problems: paramProblems }), [dirty, paramProblems]);

  const edit = (fn: (d: FlowDef) => FlowDef) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
  };

  const patchStep = (id: string, patch: Partial<{ kind: FlowStepKind; label: string; params: Record<string, unknown> }>) =>
    edit((d) => ({ ...d, steps: d.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  const addStep = (kind: FlowStepKind) => {
    const meta = metas.find((m) => m.kind === kind);
    if (!meta) return;
    const id = newStepId();
    edit((d) => {
      const orderIndex = d.steps.reduce((m, s) => Math.max(m, s.orderIndex), -1) + 1;
      return {
        ...d,
        steps: [
          ...d.steps,
          {
            id,
            defId: d.id,
            kind,
            typeVersion: meta.typeVersion,
            label: '',
            params: initStepParams(meta),
            position: nextFreeCenter(d.steps.map((s) => s.position)),
            orderIndex,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    });
    setSelStep(id);
  };

  const removeStep = (id: string) =>
    edit((d) => ({
      ...d,
      steps: d.steps.filter((s) => s.id !== id),
      // 连带删边：留着就是悬空边，服务端保存时直接 400（见文件头 ③）
      edges: d.edges.filter((e) => e.fromStepId !== id && e.toStepId !== id),
    }));

  const moveStep = (id: string, pos: Point) =>
    edit((d) => ({ ...d, steps: d.steps.map((s) => (s.id === id ? { ...s, position: pos } : s)) }));

  /** 一个出口只能有一条边：先清掉同 (步骤, 端口) 的旧边，再按需建新的 */
  const setEdge = (fromStepId: string, port: FlowPort, toStepId: string | null) =>
    edit((d) => {
      const edges = d.edges.filter((e) => !(e.fromStepId === fromStepId && e.fromPort === port));
      if (!toStepId) return { ...d, edges };
      edgeSeq.current += 1;
      return {
        ...d,
        edges: [...edges, { id: `local-${edgeSeq.current}`, defId: d.id, fromStepId, toStepId, fromPort: port, label: '' }],
      };
    });

  const save = async () => {
    if (!draft || busy) return;
    if (!draft.name.trim()) {
      flash('先给这条流起个名字');
      return;
    }
    // 与服务端执行期同一份校验；出问题就**跳到那一步**（否则用户得自己在画布上找）
    const [problem, ...restProblems] = collectParamProblems(draft.steps);
    if (problem) {
      setSelStep(problem.stepId);
      flash(`${problem.error}${restProblems.length > 0 ? `（另有 ${restProblems.length} 处，已跳到第一处）` : ''}`);
      return;
    }
    setBusy(true);
    try {
      // 用服务端返回的那一版覆盖草稿：边 id 是它生成的（本地只有临时 id）
      const saved = await saveDef(draft);
      setDraft(saved);
      setDirty(false);
      setSelStep((prev) => (saved.steps.some((s) => s.id === prev) ? prev : null));
      flash(`已保存（定义 v${saved.version}）`);
      await reloadDefs();
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const create = async (templateKey: string) => {
    setBusy(true);
    try {
      const d = await createNewDef(templateKey, metas);
      await reloadDefs();
      setDefId(d.id);
      flash(`已按模板新建（${d.steps.length} 步）——主题改成你要学的，就能直接跑`);
    } catch (e) {
      flash(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '新建失败');
    } finally {
      setBusy(false);
    }
  };

  const clone = async (id: string) => {
    setBusy(true);
    try {
      const d = await cloneFlow(id);
      await reloadDefs();
      setDefId(d.id);
      flash('已克隆成一条新流（跑过的运行不受影响）');
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '克隆失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await removeDef(id);
      if (defId === id) setDefId(null);
      await reloadDefs();
      flash('已删除这条流（跑过的运行会保留）');
    } catch (e) {
      flash(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fl-page">
      <DefList
        defs={defs}
        currentId={defId}
        busy={busy}
        onPick={(id) => {
          if (dirty && id !== defId) {
            flash('上一条流有未保存的改动，已放弃');
          }
          setDefId(id);
        }}
        onCreate={(key) => void create(key)}
        onClone={(id) => void clone(id)}
        onRemove={(id) => void remove(id)}
      />

      <div className="fl-main">
        {!draft ? (
          <div className="fl-empty">
            <p>选一条学习流开始编排</p>
            <p className="fl-empty-sub">
              学习流 = 固定下来的一套学习顺序。每一步是一个学习交互体验（讲解/出题/判分/复盘/沉淀/总结），
              连线决定下一步跑哪个。
            </p>
          </div>
        ) : (
          <>
            <div className="fl-topbar">
              <input
                className="fl-name"
                value={draft.name}
                placeholder="给这条流起个名字"
                onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
              />
              <span className="fl-ver">v{draft.version}</span>
              {dirty && <span className="fl-dirty">有未保存的改动</span>}
              <button className="fl-btn primary" disabled={!dirty || busy} onClick={() => void save()}>
                保存
              </button>
            </div>
            <input
              className="fl-desc"
              value={draft.description}
              placeholder="一句话说明这条流是干什么的（可留空）"
              onChange={(e) => edit((d) => ({ ...d, description: e.target.value }))}
            />

            <div className="fl-editor">
              <FlowCanvas
                steps={draft.steps}
                edges={draft.edges}
                selectedId={selStep}
                wiredKinds={wiredSet}
                onSelect={setSelStep}
                onMove={moveStep}
              />
              <StepPanel
                steps={draft.steps}
                edges={draft.edges}
                stepId={selStep}
                metas={metas}
                onPatch={patchStep}
                onAdd={addStep}
                onRemove={removeStep}
                onSetEdge={setEdge}
              />
            </div>

            <RunPanel
              defId={draft.id}
              {...(runBlock ?? {})}
              {...(onGoGraph ? { onGoGraph } : {})}
              onJumpToStep={(id) => setSelStep(id)}
            />
          </>
        )}
      </div>

      {msg && <div className="fl-msg">{msg}</div>}
    </div>
  );
}
