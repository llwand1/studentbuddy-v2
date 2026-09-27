/**
 * 任务清单契约（标准 CoT 进度面板）—— **前后端唯一事实源**。
 *
 * 为什么放进 shared：此前 TaskItem 有三份定义（server `chat/task-list.ts`、web
 * `features/chat/useChatStream.ts`、本包 sse-events 的内联字面量），加一个状态就要改三处，
 * 漏一处就是「后端发了新状态、前端不认」的静默降级。收敛到本文件后两侧只引用不复制。
 *
 * 状态三态：`pending`（待办）/ `in_progress`（正在做，长任务时用户靠它知道当前进行到哪条）/
 * `done`（已完成）。模型经 `update_tasks` 工具维护，每次变更经 SSE `tasks` 事件**全量下发**
 * （前端整表替换，不做本地合并——面板永远等于服务端当前状态）。
 */
export type TaskStatus = 'pending' | 'in_progress' | 'done';

export interface TaskItem {
  text: string;
  status: TaskStatus;
}

/**
 * 单清单条数上限。清单是给用户看进度的，超过 10 条说明拆得太碎，引导模型收敛粒度。
 * 放在 shared 是因为它是**契约参数**（工具 schema 的说明与校验、前端展示口径都引用它）。
 */
export const MAX_TASK_ITEMS = 10;

/** 单次增量更新的条数上限：一次改太多说明该走全量覆盖，而不是逐条打补丁 */
export const MAX_TASK_UPDATES = 10;

/** 三态合法值集合（校验用；顺序即展示顺序） */
export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'done'];

/** 状态归一：非法/缺失一律落 `pending`（宁可显示待办，也不要因一个脏字段丢掉整条） */
export function normalizeTaskStatus(raw: unknown): TaskStatus {
  return raw === 'done' || raw === 'in_progress' ? raw : 'pending';
}
