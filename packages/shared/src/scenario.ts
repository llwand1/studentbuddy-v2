/**
 * 情景题契约（契约 docs/SCENARIO-SPEC.md v1.0，2026-09-17 新建，前后端共用一份）。
 *
 * 情景题 = AI 生成一个可交互 HTML demo，demo 内嵌评分点（task），用户在 demo 里操作，
 * 「发生了什么」经桥接脚本 → postMessage → 宿主面板 → REST 回传，**对错由服务端按 criteria 判**。
 * ⚠️ 2026-09-26 回标：判完原本还走 `recordAnswer` 落 `quiz_stats`（「每个评分点在统计层就是一道
 *   普通题」，契约 §0.1）——那道记账随题库整族断线，现在**只出现场对错、不留历史**；
 *   契约 §0.1 与 SCENARIO-SPEC 的同段口径同批改。
 *
 * 出题方式不固定（demo 爱怎么玩怎么玩），但两条硬规定：
 * ① 每个评分点必须有可机器判定的 criteria（normalize 时缺失即丢弃）；
 * ② 回传只有一条通道（本文件的桥接脚本 + 消息形状），宿主与服务端各有白名单。
 */

// ── 对错标准（首期三种判型，契约 §1/§3）──

/** choice：observed 须为选中下标数组，与 answer 集合相等（去重后同长且逐个命中） */
export interface ScenarioCriteriaChoice {
  kind: 'choice';
  answer: number[];
}
/** state：observed 与 value 逐字相等（String 化比较，容忍 number/string 边界） */
export interface ScenarioCriteriaState {
  kind: 'state';
  value: string | number | boolean;
}
/** order：observed 须为与 answer 完全同序的字符串数组 */
export interface ScenarioCriteriaOrder {
  kind: 'order';
  answer: string[];
}

export type ScenarioCriteria = ScenarioCriteriaChoice | ScenarioCriteriaState | ScenarioCriteriaOrder;

export const SCENARIO_CRITERIA_KINDS = ['choice', 'state', 'order'] as const;

// ── 评分点与套题 ──

export interface ScenarioTask {
  /** 评分点 id（demo 内引用；回传白名单的键） */
  id: string;
  /** 任务描述（统计页/列表展示用） */
  prompt: string;
  criteria: ScenarioCriteria;
  /** 可选提示 */
  hint?: string;
}

export interface ScenarioPayload {
  title: string;
  tasks: ScenarioTask[];
}

/** 评分点上限：demo 里塞太多评分点会让一局长得没法玩完，10 与单题型上限同档 */
export const MAX_SCENARIO_TASKS = 10;

/** 情景题在 quiz_bank.source 的登记值（列表按它分派练习视图） */
export const SCENARIO_SOURCE = 'scenario';

/** demo HTML 上限（与 preview 同一套账，契约 §4） */
export const MAX_SCENARIO_HTML_CHARS = 512 * 1024;

// ── 回传消息契约（唯一上行通道，契约 §2）──

export const SCENARIO_REPORT_TYPE = 'sb-scenario-report';
export const SCENARIO_READY_TYPE = 'sb-scenario-ready';

/** demo → 宿主的 postMessage 形状。demoId 由服务端出页时注入桥接，宿主比对防串台 */
export interface ScenarioReportMessage {
  v: 1;
  type: typeof SCENARIO_REPORT_TYPE;
  demoId: string;
  taskId: string;
  /** 「发生了什么」的事实（选中项 / 状态值 / 排列）；判分交给服务端，宿主不判 */
  observed: unknown;
}

/**
 * 桥接脚本源码。服务端出页时把 `__SB_DEMO_ID__` 替换为真 demoId 后注入 `<head>`。
 * 只做一件事：暴露 `window.SBScenario.report(taskId, observed)` → parent.postMessage。
 * demo 作者（AI 或人）只许调这一个函数——凡绕过它直接 fetch 的路都被 CSP sandbox 堵死。
 * 包 try/catch：桥接绝不能因为自己抛错把宿主的 demo 玩崩（它是最不该坏的一层）。
 */
export const SCENARIO_BRIDGE_JS = `(function(){
  var DEMO_ID = '__SB_DEMO_ID__';
  function send(type, taskId, observed) {
    try {
      parent.postMessage({ v: 1, type: type, demoId: DEMO_ID, taskId: taskId, observed: observed === undefined ? null : observed }, '*');
    } catch (e) { /* 桥接不抛错：上报失败也不许影响 demo 本身 */ }
  }
  window.SBScenario = {
    report: function(taskId, observed) { send('${SCENARIO_REPORT_TYPE}', String(taskId), observed); }
  };
  send('${SCENARIO_READY_TYPE}', '', null);
})();`;

// ── normalize（入库闸门：标准不完整的评分点等于没有这道题，契约 §9）──

function normalizeCriteria(input: unknown): ScenarioCriteria | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  if (c.kind === 'choice') {
    if (!Array.isArray(c.answer) || c.answer.length === 0) return null;
    const answer = c.answer.filter((n): n is number => typeof n === 'number' && Number.isInteger(n));
    // 入库即存规范升序（判分时本就排序比较，库里也存同一形状——两次实现只留一种顺序观）
    return answer.length > 0 ? { kind: 'choice', answer: [...new Set(answer)].sort((a, b) => a - b) } : null;
  }
  if (c.kind === 'state') {
    if (typeof c.value !== 'string' && typeof c.value !== 'number' && typeof c.value !== 'boolean') return null;
    return { kind: 'state', value: c.value };
  }
  if (c.kind === 'order') {
    if (!Array.isArray(c.answer) || c.answer.length === 0) return null;
    const answer = c.answer.filter((s): s is string => typeof s === 'string');
    return answer.length > 0 && answer.length === c.answer.length ? { kind: 'order', answer } : null;
  }
  return null;
}

/**
 * 校验规范化评分点清单：缺 id/prompt/criteria 或 criteria 形状不对的**整条丢弃**（不静默修正、
 * 不猜——「对错标准不完整」的评分点留在库里就是一笔永远算不清的账）；id 重复的后到丢弃
 * （白名单键不允许二义）；截 MAX_SCENARIO_TASKS。
 */
export function normalizeScenarioTasks(input: unknown): ScenarioTask[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: ScenarioTask[] = [];
  for (const raw of input) {
    if (out.length >= MAX_SCENARIO_TASKS) break;
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id.trim()) continue;
    if (typeof t.prompt !== 'string' || !t.prompt.trim()) continue;
    const criteria = normalizeCriteria(t.criteria);
    if (!criteria) continue;
    const id = t.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const task: ScenarioTask = { id, prompt: t.prompt.trim(), criteria };
    if (typeof t.hint === 'string' && t.hint.trim()) task.hint = t.hint.trim();
    out.push(task);
  }
  return out;
}

/** 情景题套题整体校验：title 取首行兜底「情景题」，tasks 走 normalize；0 评分点返回 null（不成套） */
export function normalizeScenarioPayload(input: unknown): ScenarioPayload | null {
  if (!input || typeof input !== 'object') return null;
  const p = input as Record<string, unknown>;
  const tasks = normalizeScenarioTasks(p.tasks);
  if (tasks.length === 0) return null;
  const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : '情景题';
  return { title, tasks };
}

// ── judgeTask（纯函数判分，契约 §3；demo 上报垃圾一律判错不抛错，ADR-4）──

export function judgeTask(criteria: ScenarioCriteria, observed: unknown): boolean {
  if (criteria.kind === 'choice') {
    if (!Array.isArray(observed)) return false;
    if (!observed.every((n) => typeof n === 'number' && Number.isInteger(n))) return false;
    const picked = [...new Set(observed as number[])].sort((a, b) => a - b);
    const answer = [...criteria.answer].sort((a, b) => a - b);
    return picked.length === answer.length && picked.every((n, i) => n === answer[i]);
  }
  if (criteria.kind === 'order') {
    if (!Array.isArray(observed)) return false;
    if (observed.length !== criteria.answer.length) return false;
    if (!observed.every((s) => typeof s === 'string')) return false;
    return (observed as string[]).every((s, i) => s === criteria.answer[i]);
  }
  // state：undefined/null 恒错（「没上报」不等于「上报了空」）
  if (observed === undefined || observed === null) return false;
  return String(observed) === String(criteria.value);
}
