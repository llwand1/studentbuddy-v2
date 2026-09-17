/**
 * 学习流·步骤参数校验 —— **前后端唯一一份**（契约 docs/STUDY-FLOW-SPEC.md §5.2）。
 *
 * ★ 为什么必须放 shared（2026-09-17 从前端批次上提）：
 *   前端参数表单要在**提交前**就把「必填没填」「题数填了 999」拦下来，服务端在执行期还要再校验一次。
 *   若两边各写一份，就必然出现「表单放行、服务端拒绝」或更糟的「一边钳到 10、一边钳到 5」——
 *   这类**口径漂移**是本仓明令规避的病（`AGENTS.md` 禁类型双写）。
 *   ⇒ 校验本身就是「契约」，和 `FLOW_STEP_METAS` 同属一个事实源，一起放 shared。
 *
 * ★ 服务端侧不重复实现：`learning/flow-registry.ts` 改为 re-export 本文件
 *   （既有调用方零改动），这样「前端拿到的校验结论」与「执行期服务端拿到的」是**同一段代码**跑出来的。
 *
 * 规则（三条都刻意，不是随手写）：
 *  ① 必填缺失 ⇒ **拒绝**，不静默落默认值——用户以为自己配了、实际没配，比报错更难查；
 *  ② 选填缺失 ⇒ 落该参数的 `default`（「不填也能跑」的兜底）；
 *  ③ 数值越界 ⇒ **钳制**而不是拒绝（同 `normalizeTerms` 的 importance 手法）——
 *     用户在表单里把滑块拖到底，不该收到一句「不允许」，而该看到值自己回到边界。
 */
import { FLOW_STEP_METAS, findFlowStepMeta } from './study-flow.js';
import type { FlowParamMeta } from './study-flow.js';

export type ParamCheck = { ok: true; params: Record<string, unknown> } | { ok: false; error: string };

/** 单参数类型强制（number 越界**钳制**而非拒绝） */
function coerceParam(p: FlowParamMeta, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (p.type === 'boolean') {
    if (typeof v === 'boolean') return { ok: true, value: v };
    if (v === 'true') return { ok: true, value: true };
    if (v === 'false') return { ok: true, value: false };
    return { ok: false, error: `应为 true/false` };
  }
  if (p.type === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return { ok: false, error: `应为数字` };
    const lo = p.min ?? Number.NEGATIVE_INFINITY;
    const hi = p.max ?? Number.POSITIVE_INFINITY;
    return { ok: true, value: Math.min(hi, Math.max(lo, n)) };
  }
  if (p.type === 'select') {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!p.options?.includes(s)) {
      return { ok: false, error: `只能是 ${p.options?.join(' / ') ?? ''} 之一` };
    }
    return { ok: true, value: s };
  }
  // string：宽容收 number（用户可能把「第 3 章」写成 3），但拒绝对象/数组
  if (typeof v === 'string') return { ok: true, value: v.trim() };
  if (typeof v === 'number') return { ok: true, value: String(v) };
  return { ok: false, error: `应为文本` };
}

/**
 * 按注册表声明校验一个步骤的入参。
 * 未知 kind 也会被拒（含可用类型清单）——「步骤类型必须命中注册表」是范围红线的机器化表达。
 */
export function validateStepParams(kind: string, raw: unknown): ParamCheck {
  const meta = findFlowStepMeta(kind);
  if (!meta) {
    const known = FLOW_STEP_METAS.map((m) => m.kind).join(' / ');
    return { ok: false, error: `未知步骤类型「${kind}」，可用类型：${known}` };
  }
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const p of meta.params) {
    const v = src[p.key];
    const missing = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (missing) {
      if (p.required) {
        return { ok: false, error: `步骤「${meta.label}」缺少必填参数：${p.label}（${p.key}）` };
      }
      if (p.default !== undefined) out[p.key] = p.default;
      continue;
    }
    const coerced = coerceParam(p, v);
    if (!coerced.ok) {
      return { ok: false, error: `步骤「${meta.label}」的参数「${p.label}」${coerced.error}` };
    }
    out[p.key] = coerced.value;
  }
  return { ok: true, params: out };
}
