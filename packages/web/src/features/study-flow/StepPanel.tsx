/**
 * StepPanel — 单个步骤的**参数与出口编排**面板（契约 docs/STUDY-FLOW-SPEC.md §2 / §5.2）。
 *
 * 老板那句「每一个交互体验是可以被当成『点』去编排的，用户可以自己定义下一步执行哪个学习交互体验」，
 * 在这个面板里落成两件事：
 *  ① **参数表单**——按 `FLOW_STEP_METAS` 的声明渲染（选哪种交互 + 填什么参数，两者都由注册表说了算）；
 *  ② **出口连线**——`next` / `correct` / `wrong` 三个出口各选一个目标步骤。
 *     三个出口就是"分支"的全部：答对走哪、答错走哪、其余走哪。
 *
 * ★ 未接执行器的类型在下拉里**禁用**（契约 §7）：让用户配好一条流、跑到一半才失败，是最差的时点。
 * ★ 出口**允许留空**：留空时运行器按 `order_index` 线性推进（服务端 `pickNextStep` 的兜底），
 *   这样"只放节点不连线"也能跑通——面板上必须把这条说明写出来，否则用户不敢留空。
 */
import { findFlowStepMeta, type FlowEdgeDef, type FlowPort, type FlowStepDef, type FlowStepKind } from '@sb/shared';
import type { FlowStepMetaWired } from '../../lib/api-study-flow';
import { clampOnInput, displayStepLabel, initStepParams, paramRangeHint } from './flow-form';
import { portLabel } from './flow-layout';

const PORTS: FlowPort[] = ['next', 'correct', 'wrong'];

export function StepPanel({
  steps,
  edges,
  stepId,
  metas,
  onPatch,
  onAdd,
  onRemove,
  onSetEdge,
}: {
  steps: FlowStepDef[];
  edges: FlowEdgeDef[];
  stepId: string | null;
  metas: FlowStepMetaWired[];
  onPatch: (id: string, patch: Partial<Pick<FlowStepDef, 'kind' | 'label' | 'params'>>) => void;
  onAdd: (kind: FlowStepKind) => void;
  onRemove: (id: string) => void;
  /** 把某步骤的某出口连到目标（`null` = 取消该连线，交回顺序推进） */
  onSetEdge: (fromStepId: string, port: FlowPort, toStepId: string | null) => void;
}) {
  const step = steps.find((s) => s.id === stepId) ?? null;

  const adder = (
    <div className="fl-adder">
      <div className="fl-panel-title">加一个步骤</div>
      <div className="fl-adder-list">
        {metas.map((m) => (
          <button
            key={m.kind}
            className="fl-adder-item"
            disabled={!m.wired}
            title={m.wired ? m.description : '这一种还没接执行器，现在加进去跑到它会失败'}
            onClick={() => onAdd(m.kind)}
          >
            <span className="fl-adder-label">
              {m.label}
              {!m.wired && <em className="fl-adder-tag">未接</em>}
            </span>
            <span className="fl-adder-desc">{m.description}</span>
          </button>
        ))}
      </div>
    </div>
  );

  if (!step) {
    return (
      <div className="fl-panel">
        <div className="fl-panel-title">步骤</div>
        <p className="fl-panel-hint">在画布上点一个步骤来改它的参数与下一步；或者直接加一个新的。</p>
        {adder}
      </div>
    );
  }

  const meta = findFlowStepMeta(step.kind);
  const wired = metas.find((m) => m.kind === step.kind)?.wired ?? false;
  const others = steps.filter((s) => s.id !== step.id);

  /** 该出口当前连到谁（没连返回空串，`select` 就显示「不连」那一项） */
  const edgeTargetOf = (port: FlowPort) =>
    edges.find((e) => e.fromStepId === step.id && e.fromPort === port)?.toStepId ?? '';

  return (
    <div className="fl-panel">
      <div className="fl-panel-title">步骤设置</div>

      <label className="fl-field">
        <span className="fl-field-label">交互类型</span>
        <select
          value={step.kind}
          onChange={(e) => {
            const kind = e.target.value as FlowStepKind;
            const next = metas.find((m) => m.kind === kind);
            // 换类型 = 换交互：旧参数对新交互没有意义，直接用新类型的默认值重来
            if (next) onPatch(step.id, { kind, params: initStepParams(next) });
          }}
        >
          {metas.map((m) => (
            <option key={m.kind} value={m.kind} disabled={!m.wired}>
              {m.label}
              {m.wired ? '' : '（未接执行器）'}
            </option>
          ))}
        </select>
      </label>

      {!wired && <p className="fl-warn">这一种交互还没接执行器，跑到它就会停下来报错。</p>}

      <label className="fl-field">
        <span className="fl-field-label">显示名</span>
        <input
          value={step.label}
          placeholder={meta?.label ?? step.kind}
          onChange={(e) => onPatch(step.id, { label: e.target.value })}
        />
      </label>

      {meta?.params.map((p) => {
        const hint = paramRangeHint(p);
        return (
          <label key={p.key} className="fl-field">
            <span className="fl-field-label">
              {p.label}
              {p.required && <em className="fl-req">必填</em>}
              {hint && <em className="fl-range">{hint}</em>}
            </span>
            {p.type === 'boolean' ? (
              <input
                type="checkbox"
                className="fl-check"
                checked={Boolean(step.params[p.key])}
                onChange={(e) => onPatch(step.id, { params: { ...step.params, [p.key]: e.target.checked } })}
              />
            ) : p.type === 'select' ? (
              <select
                value={String(step.params[p.key] ?? '')}
                onChange={(e) => onPatch(step.id, { params: { ...step.params, [p.key]: e.target.value } })}
              >
                {(p.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={p.type === 'number' ? 'number' : 'text'}
                value={String(step.params[p.key] ?? '')}
                placeholder={p.example ?? ''}
                onChange={(e) =>
                  onPatch(step.id, { params: { ...step.params, [p.key]: clampOnInput(p, e.target.value) } })
                }
              />
            )}
            {p.hint && <span className="fl-field-hint">{p.hint}</span>}
          </label>
        );
      })}

      <div className="fl-ports">
        <div className="fl-panel-title">下一步走哪</div>
        <p className="fl-panel-hint">
          留空就按步骤顺序往下走；要让「答对」和「答错」走不同的路，在这里各选一个目标。
        </p>
        {PORTS.map((port) => (
          <label key={port} className="fl-field">
            <span className="fl-field-label">
              {portLabel(port)}
              {port !== 'next' && <em className="fl-port-tag">{port}</em>}
            </span>
            <select value={edgeTargetOf(port)} onChange={(e) => onSetEdge(step.id, port, e.target.value || null)}>
              <option value="">（不连，按顺序走）</option>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {displayStepLabel(s.label, s.kind, findFlowStepMeta(s.kind)?.label)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <button className="fl-btn danger" onClick={() => onRemove(step.id)}>
        删除这个步骤
      </button>

      {adder}
    </div>
  );
}
