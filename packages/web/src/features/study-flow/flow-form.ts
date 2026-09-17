/**
 * flow-form —— 步骤参数表单的**渲染派生逻辑**（契约 docs/STUDY-FLOW-SPEC.md §5.2）。
 *
 * ★ 校验**不在这里**：`validateStepParams` 在 `@sb/shared`，前端表单与服务端执行期用的是
 *   **同一段代码**（不是"口径保持一致"的口头承诺）。本文件只管「让表单有东西可显示」
 *   与「输入时的即时钳制」，校验是提交那一刻的事。
 *
 * ★ 即时钳制的取舍：数值越界时**输入框里的值当场回到区间**，而不是等提交后静默改。
 *   代价是用户没法把 15 打进 max=10 的框（打到第二位就被钳回）——但比起
 *   「填了 999、提交后变成 10、自己还不知道」，当场看见更接近事实，且与服务端钳制口径同源。
 */
import {
  findFlowStepMeta,
  validateStepParams,
  type FlowParamMeta,
  type FlowStepKind,
  type FlowStepMeta,
} from '@sb/shared';

export type ParamValues = Record<string, unknown>;

/** 一处参数问题，**带步骤定位**——用户看到的不该只是一句"缺少必填参数" */
export interface ParamProblem {
  stepId: string;
  /** 步骤在界面上显示的名字（「已跳到那一步」这类提示用） */
  stepLabel: string;
  error: string;
}

/**
 * 逐步骤跑一遍 `shared` 的校验，收集**全部**问题（不是遇到第一个就返回）。
 *
 * ★ 为什么收集全部而不是快速失败：用户点「保存」时希望一次看到所有填错的地方，
 *   改一个存一次、每次又冒出下一个，是很烦的来回。
 * ★ 校验用的是**服务端执行期那一份代码**，所以这里过了，服务端就不会因为参数问题回 400。
 * ★ 为什么返回 `stepId` 而不是一串字符串（2026-09-17 老板实测反馈）：原来只给一句话，
 *   用户得自己在画布上找是哪一步。带 id 之后保存/开跑能**自动跳到出问题的那一步**——
 *   「缺少必填参数」就从一句无从下手的报错，变成"跳到那一步、那个框就在眼前"。
 */
export function collectParamProblems(
  steps: Array<{ id: string; kind: FlowStepKind; label?: string; params: Record<string, unknown> }>,
): ParamProblem[] {
  const out: ParamProblem[] = [];
  for (const s of steps) {
    const c = validateStepParams(s.kind, s.params);
    if (!c.ok) {
      out.push({
        stepId: s.id,
        stepLabel: displayStepLabel(s.label ?? '', s.kind, findFlowStepMeta(s.kind)?.label),
        error: c.error,
      });
    }
  }
  return out;
}

/**
 * 表单初值：按声明逐项取「已存值 → 默认值 → 类型零值」。
 * ★ 为什么要给类型零值：`undefined` 会让 `<input value={x}>` 在受控/非受控之间跳变（React 会警告），
 *   且 `select` 没有匹配项时浏览器会显示第一项、状态里却是空 —— 两边不一致最难查。
 */
export function initStepParams(meta: FlowStepMeta, existing?: Record<string, unknown>): ParamValues {
  const out: ParamValues = {};
  for (const p of meta.params) {
    const cur = existing?.[p.key];
    if (cur !== undefined && cur !== null) {
      out[p.key] = cur;
      continue;
    }
    if (p.default !== undefined) {
      out[p.key] = p.default;
      continue;
    }
    if (p.type === 'boolean') out[p.key] = false;
    else if (p.type === 'number') out[p.key] = p.min ?? 0;
    else if (p.type === 'select') out[p.key] = p.options?.[0] ?? '';
    else out[p.key] = '';
  }
  return out;
}

/**
 * 输入框 onChange → 该参数的新值。
 *  · `number`：能解析就钳到 `[min, max]`（空串保留为 `''`，让用户能清空重打）；
 *  · `boolean`：由 checkbox 传布尔；
 *  · 其余原样（字符串的 trim 留给提交时由 `validateStepParams` 做）。
 */
export function clampOnInput(param: FlowParamMeta, raw: string | number | boolean): unknown {
  if (param.type === 'boolean') return Boolean(raw);
  if (param.type === 'number') {
    if (raw === '' || raw === null) return '';
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) return '';
    const lo = param.min ?? Number.NEGATIVE_INFINITY;
    const hi = param.max ?? Number.POSITIVE_INFINITY;
    return Math.min(hi, Math.max(lo, n));
  }
  return String(raw);
}

/** 数值参数的区间提示（表单标签右侧用；无区间返回空串） */
export function paramRangeHint(p: FlowParamMeta): string {
  if (p.type !== 'number') return '';
  if (p.min !== undefined && p.max !== undefined) return `${p.min}–${p.max}`;
  if (p.min !== undefined) return `≥ ${p.min}`;
  if (p.max !== undefined) return `≤ ${p.max}`;
  return '';
}

/**
 * 节点卡片上的一行参数摘要。
 * 只列**该步骤显式声明过的**参数、且跳过空值——卡片上写「讲解主题：」比不写更难看。
 */
export function stepParamsSummary(meta: FlowStepMeta, values: ParamValues): string {
  const parts: string[] = [];
  for (const p of meta.params) {
    const v = values[p.key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean') {
      parts.push(`${p.label}${v ? '开' : '关'}`);
      continue;
    }
    parts.push(`${p.label} ${String(v)}`);
  }
  return parts.join(' · ');
}

/** 步骤在画布上显示的名字：用户改过就用用户的，否则回落注册表默认名 */
export function displayStepLabel(label: string, kind: string, metaLabel: string | undefined): string {
  const own = label.trim();
  if (own) return own;
  return metaLabel ?? kind;
}
