/**
 * 情景题展示与校验的纯函数层（契约 docs/SCENARIO-SPEC.md §2/§5，2026-09-17 新建）。
 * 本仓 .tsx 无测试环境——判定全在这里，组件只挂（先例 mix-report.ts / doc-name.ts）。
 * ★ 2026-09-26 题库整族下线：原先挂在这儿的两个「题库行是不是情景题」判定
 *   （`isScenarioItem` / `isScenarioPayload`）随唯一调用方 `QuizBankPage` 一起删除，
 *   测试同批摘。聊天流出卡走的是 `chat/chat-blocks.ts` 里那份自己的 payload 校验。
 */
import type { ScenarioPayload, ScenarioReportMessage } from '@sb/shared';
import { SCENARIO_REPORT_TYPE } from '@sb/shared';

export interface ValidatedReport {
  taskId: string;
  observed: unknown;
}

/**
 * 宿主收到的 postMessage 校验（白名单三道中的前两道在宿主，第三道在服务端，契约 §2）：
 * type 匹配 → demoId 匹配当前面板（防串台）→ taskId 在当前套题白名单内。
 * 全过才返回可上报的报告，否则 null（不可信侧的噪音静默丢弃，不弹错误打扰用户）。
 */
export function validateScenarioReport(
  data: unknown,
  demoId: string,
  taskIds: ReadonlySet<string>,
): ValidatedReport | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Partial<ScenarioReportMessage> & Record<string, unknown>;
  if (m.type !== SCENARIO_REPORT_TYPE) return null;
  if (m.v !== 1 || typeof m.demoId !== 'string' || m.demoId !== demoId) return null;
  if (typeof m.taskId !== 'string' || !taskIds.has(m.taskId)) return null;
  return { taskId: m.taskId, observed: m.observed };
}

/** 单个评分点的宿主侧完成态：pending（未回传）/ correct / wrong（**以服务端响应为准**） */
export type TaskState = 'pending' | 'correct' | 'wrong';

export interface ScenarioProgressItem {
  task: ScenarioPayload['tasks'][number];
  state: TaskState;
}

export interface ScenarioProgress {
  items: ScenarioProgressItem[];
  total: number;
  doneCount: number;
  allDone: boolean;
}

/**
 * 面板任务清单的展示模型：results 是「taskId → 服务端判分结果」的映射（只增不改——
 * 首判定了就不被后续重试覆盖，重试属 M-retry 批，见契约 §9）。
 */
export function scenarioProgress(
  payload: ScenarioPayload,
  results: Readonly<Record<string, boolean>>,
): ScenarioProgress {
  const items = payload.tasks.map((task) => {
    const r = results[task.id];
    const state: TaskState = r === undefined ? 'pending' : r ? 'correct' : 'wrong';
    return { task, state };
  });
  const doneCount = items.filter((i) => i.state !== 'pending').length;
  return { items, total: items.length, doneCount, allDone: doneCount === items.length };
}

/** 汇总一句（ADR-5 不静默：做了几个、对了几个，面板顶部常驻） */
export function progressSummary(progress: ScenarioProgress): string {
  const correct = progress.items.filter((i) => i.state === 'correct').length;
  return `完成 ${progress.doneCount}/${progress.total} · 判对 ${correct}`;
}
