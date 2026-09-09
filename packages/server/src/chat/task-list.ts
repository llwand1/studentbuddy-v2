/**
 * chat/task-list —— 任务清单工具（标准 CoT 过程反馈，2026-09-09 批次 4）。
 *
 * 为什么不进 tools.ts 注册表：该文件正被并行会话在途改动（manage_terms），
 * 按 R1 避让——本工具走 flow.ts 的 exec 注入点接入（runToolCalls 支持自定义执行器），
 * toolDefinitions() 拼接 definition，**零改动 tools.ts**；拆注册表目录（S1 终态）时再并回去。
 *
 * 语义：模型对复杂多步任务先整体列出清单，关键节点完成后**整体覆盖式**更新
 * （与 Coze/WorkBuddy 的 todo 面板同构：面板只认最后一次调用发来的全量列表）。
 * 每次调用都经 SSE `tasks` 事件全量下发，前端 TaskPanel 直接整表替换。
 */
import type { ToolDefinition } from '../llm/types.js';

export interface TaskItem {
  text: string;
  status: 'pending' | 'done';
}

/** 单清单上限：清单是给用户看进度的，超过 10 条说明拆得太碎，提示模型收敛 */
export const MAX_TASK_ITEMS = 10;

export const TASKS_TOOL: { definition: ToolDefinition } = {
  definition: {
    type: 'function',
    function: {
      name: 'update_tasks',
      description:
        '维护给用户看的任务清单（进度面板）。处理多步骤任务时先调用它列出全部步骤（全量覆盖式：每次调用都发送完整清单，不是增量）；' +
        '完成一个关键步骤后再次调用，把已完成条目的 status 改为 done。简单问题（一步能答完）不要使用。' +
        '每次最多 10 条，每条一句话。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: '完整任务清单（覆盖式替换上一个版本）',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '任务内容，一句话' },
                status: { type: 'string', enum: ['pending', 'done'], description: 'pending=待办，done=已完成' },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
};

export interface TaskListResult {
  ok: boolean;
  items: TaskItem[];
  /** 回灌给模型的确认/纠错文案 */
  content: string;
}

/** 解析并校验模型发来的清单：坏 JSON/超限/空条目都给「怎么改对」的指示（契约 §4.2 纠错口径） */
export function parseTaskList(argsJson: string): TaskListResult {
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson);
  } catch {
    return { ok: false, items: [], content: 'update_tasks 参数不是合法 JSON：tasks 必须是 [{text, status}] 数组。' };
  }
  const arr = (raw as { tasks?: unknown })?.tasks;
  if (!Array.isArray(arr) || arr.length === 0) {
    return { ok: false, items: [], content: 'tasks 必须是非空数组，每项形如 {"text":"...","status":"pending|done"}。' };
  }
  if (arr.length > MAX_TASK_ITEMS) {
    return {
      ok: false,
      items: [],
      content: `任务清单最多 ${MAX_TASK_ITEMS} 条（收到 ${arr.length} 条）：请合并或拆分粒度后再调用。`,
    };
  }
  const items: TaskItem[] = [];
  for (const it of arr) {
    const text = typeof (it as TaskItem)?.text === 'string' ? ((it as TaskItem).text as string).trim() : '';
    const status = (it as TaskItem)?.status === 'done' ? 'done' : 'pending';
    if (!text) continue; // 空条目直接丢弃，不为它失败整单
    items.push({ text: text.slice(0, 100), status });
  }
  if (items.length === 0) {
    return { ok: false, items: [], content: 'tasks 里没有任何有效条目：每项需要非空的 text 字段。' };
  }
  const done = items.filter((i) => i.status === 'done').length;
  return { ok: true, items, content: `任务清单已更新：共 ${items.length} 项，已完成 ${done} 项。` };
}
