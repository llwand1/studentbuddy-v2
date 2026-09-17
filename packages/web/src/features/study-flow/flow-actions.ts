/**
 * flow-actions —— 学习流定义的**提交动作**（保存/新建/克隆/删除）。契约 docs/STUDY-FLOW-SPEC.md §2.3。
 *
 * ★ 为什么从组件里抽出来（两条都是实的）：
 *  ① `FlowPage.tsx` 受 `.tsx ≤300 行` 的 gates 红线约束，而这些动作里一行 JSX 都没有；
 *  ② 「保存前先用 shared 校验逐步骤过一遍」是本批的一条纪律，抽成函数就能被单测钉住
 *     —— 留在组件里只能靠人工点页面验证。
 *
 * ★ 提交形状的两个关键点（与服务端 `validateDefInput` 对齐，别想当然）：
 *   · **步骤 id 带着走**：服务端允许客户端指定步骤 id；不带着走的话每次保存都会换一批 id，
 *     而「同一个步骤」在用户心里是同一个东西（运行轨迹、产出的知识节点都记着 step_id）。
 *   · **边不带 id**：`FlowDefInput.edges` 里根本没有 id 字段，边 id 由服务端生成。
 *     所以画布上本地新增的边用的是临时 id（`local-n`），保存后必须**回读服务端返回值**
 *     才算拿到真 id —— 这也是 `saveDef` 的返回值要覆盖 `draft` 的原因。
 */
import type { FlowDef, FlowDefInput } from '@sb/shared';
import { api } from '../../lib/api';
import type { FlowStepMetaWired } from '../../lib/api-study-flow';
import { buildTemplateDef, findTemplate } from './flow-templates';

/**
 * 客户端生成步骤 id（服务端接受客户端指定的 id；重复会被它拒掉，见 `validateDefInput`）。
 *
 * ★ 为什么要客户端生成、而不是让服务端发号：新建步骤后要**立刻在画布上编辑它**
 *   （选中、填参数、连出口），这些都发生在保存之前——没有 id 就没法在草稿里定位它。
 * ★ 带兜底：`crypto.randomUUID` 只在 secure context 可用，本地开 http 时可能没有。
 */
export const newStepId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 草稿 → 提交形状（`updateDef` 是**整体替换**语义，所以是全量提交，不是增量 patch） */
export function toDefInput(draft: FlowDef): FlowDefInput {
  return {
    name: draft.name.trim(),
    description: draft.description,
    steps: draft.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      params: s.params,
      position: s.position,
      orderIndex: s.orderIndex,
    })),
    edges: draft.edges.map((e) => ({
      fromStepId: e.fromStepId,
      toStepId: e.toStepId,
      fromPort: e.fromPort,
      label: e.label,
    })),
  };
}

/** 保存（整体替换）。**返回服务端那一版**——边 id 是它生成的，本地草稿必须换成它这份 */
export function saveDef(draft: FlowDef): Promise<FlowDef> {
  return api.studyFlow.updateDef(draft.id, toDefInput(draft));
}

/**
 * 从**模板**新建一条流。
 *
 * ★ 为什么不再是「给一个空步骤」（2026-09-17 老板实测反馈）：服务端对空流直接 400，
 *   所以新建无论如何都得自带步骤；但自带**一个空壳**的代价是用户一进页面就看到必填空着、
 *   保存/开跑被拒「缺少必填参数」——起点给错了。现在自带的是**一份能跑的参考**
 *   （`flow-templates.ts`，对齐 Dify 的「从模板创建」/ n8n 的 workflow template）。
 *
 * ★ 为什么要在这里拦「未接执行器的类型」：模板是给人**照抄**的，抄到一条跑到中途才失败的流，
 *   比没有模板更糟。模板本身是静态常量，这一步等于是把"模板只许用已接执行器的类型"
 *   从一句约定变成运行期可见的拒绝。
 */
export async function createNewDef(templateKey: string, metas: FlowStepMetaWired[]): Promise<FlowDef> {
  const tpl = findTemplate(templateKey);
  if (!tpl) throw new Error(`没有这个模板：${templateKey}`);
  if (metas.length === 0) throw new Error('还没拿到可用的交互类型，稍后再试');
  const wired = new Set(metas.filter((m) => m.wired).map((m) => m.kind));
  const unwired = tpl.steps.filter((s) => !wired.has(s.kind));
  if (unwired.length > 0) {
    throw new Error(
      `模板「${tpl.name}」里有还没接执行器的步骤：${[...new Set(unwired.map((s) => s.kind))].join(' / ')}`,
    );
  }
  // newStepId 注入给模板构造器：crypto.randomUUID 的兜底只留在那一处，不在模板里再抄一遍
  return api.studyFlow.createDef(buildTemplateDef(tpl, newStepId));
}

export const cloneDef = (id: string): Promise<FlowDef> => api.studyFlow.cloneDef(id);

/** 删除定义。**跑过的运行会保留**（服务端不级联删运行，它们各有自己的定义快照） */
export const removeDef = (id: string): Promise<{ ok: boolean }> => api.studyFlow.removeDef(id);
