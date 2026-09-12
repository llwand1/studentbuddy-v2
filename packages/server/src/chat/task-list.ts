/**
 * chat/task-list —— 任务清单工具（标准 CoT 过程反馈，2026-09-09 批次 4；2026-09-12 加增量模式）。
 *
 * 为什么不进 tools.ts 注册表：该文件正被并行会话在途改动（manage_terms），
 * 按 R1 避让——本工具走 flow.ts 的 exec 注入点接入（runToolCalls 支持自定义执行器），
 * toolDefinitions() 拼接 definition，**零改动 tools.ts**；拆注册表目录（S1 终态）时再并回去。
 *
 * 为什么是「有状态」的：本模块只做**纯函数**(解析/应用/渲染)，当前清单由调用方（flow.ts 的
 * `latestTasks`）持有并传入——这样合并逻辑零 IO 可单测，也不引入第二份清单状态。
 *
 * 两种入参模式（2026-09-12 新增 patch）：
 * - `tasks`（全量覆盖）：首次列清单或大改时用。语义＝整表替换，幂等、不会漂。
 * - `updates`（增量）：长任务中途**只发改动的条目**用。旧版只有全量模式，10 条清单每完成一步
 *   都要重发 10 条（费 token 且容易漏抄条目）。增量按 1 基序号定位，缺 index 即追加。
 * 两者**互斥**（同给则拒绝）：任务清单是用户可见状态，宁可让模型重来一次，也不静默丢弃它的一条指令。
 *
 * 应用纪律：**整批原子**。任一条目非法（序号越界 / 追加缺 text / 空操作 / 总数超限）整批不生效，
 * 并把「当前清单 + 序号」回灌给模型自纠——半应用会让模型以为的清单与用户看到的清单分叉。
 */
import type { ToolDefinition } from '../llm/types.js';
import {
  MAX_TASK_ITEMS,
  MAX_TASK_UPDATES,
  normalizeTaskStatus,
  type TaskItem,
  type TaskStatus,
} from '@sb/shared';

// 三态契约与上限的唯一事实源在 @sb/shared（前后端共用）；此处转发，调用方不必关心它住哪。
export { MAX_TASK_ITEMS, MAX_TASK_UPDATES, normalizeTaskStatus };
export type { TaskItem, TaskStatus };

/** 单条 text 上限：清单是给人扫一眼的，超长说明该拆条 */
const MAX_TASK_TEXT = 100;

export const TASKS_TOOL: { definition: ToolDefinition } = {
  definition: {
    type: 'function',
    function: {
      name: 'update_tasks',
      description:
        '维护给用户看的任务清单（进度面板）。两种用法，按需二选一：' +
        '① tasks＝完整清单，**只用于首次列清单**（覆盖式替换）；' +
        '② updates＝增量更新，**长任务中途只改动了少数条目时用它**，每条给 index（从 1 开始）只发改动的那几项，' +
        '不传 index 表示追加一条新任务——不要每次重发整张清单。' +
        '开始做某条时把它的 status 设为 in_progress，做完改为 done。' +
        `简单问题（一步能答完）不要使用。清单最多 ${MAX_TASK_ITEMS} 条，每条一句话。`,
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: `完整任务清单（覆盖式替换上一个版本）。仅在首次列清单时使用；最多 ${MAX_TASK_ITEMS} 条。`,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '任务内容，一句话' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'done'],
                  description: 'pending=待办，in_progress=正在做，done=已完成',
                },
              },
              required: ['text', 'status'],
            },
          },
          updates: {
            type: 'array',
            description: `增量更新（只发改动的那几条）。长任务中途更新进度时优先用它，避免重发整张清单。最多 ${MAX_TASK_UPDATES} 条。`,
            items: {
              type: 'object',
              properties: {
                index: { type: 'number', description: '第几条（从 1 开始）。不传表示追加一条新任务' },
                text: { type: 'string', description: '新的任务内容（不改内容就不用传）' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'done'],
                  description: '新状态（不改状态就不用传）',
                },
              },
            },
          },
        },
      },
    },
  },
};

/** 一条增量操作：`index` 1 基；缺省＝追加（此时必须有 text） */
export interface TaskPatchOp {
  index?: number;
  text?: string;
  status?: TaskStatus;
}

/** `parseTaskArgs` 的结果：两种合法形态 + 一种「怎么改对」的拒绝 */
export type ParsedTaskArgs =
  | { ok: true; mode: 'replace'; items: TaskItem[] }
  | { ok: true; mode: 'patch'; ops: TaskPatchOp[] }
  | { ok: false; content: string };

/** 清单渲染（带序号）：回灌给模型用，序号是 patch 模式定位的锚点，必须给 */
export function renderTaskList(items: TaskItem[]): string {
  const mark = (s: TaskStatus): string => (s === 'done' ? '[x]' : s === 'in_progress' ? '[>]' : '[ ]');
  return items.map((it, i) => `${i + 1}. ${mark(it.status)} ${it.text}`).join('\n');
}

/** 回灌文案：已应用的清单 + 计数（模型据此知道当前序号，下一次 patch 才不会错位） */
export function formatTaskList(items: TaskItem[]): string {
  const done = items.filter((i) => i.status === 'done').length;
  const doing = items.filter((i) => i.status === 'in_progress').length;
  const parts = [`共 ${items.length} 项`, `已完成 ${done} 项`];
  if (doing > 0) parts.push(`进行中 ${doing} 项`);
  return `任务清单已更新（${parts.join('，')}）：\n${renderTaskList(items)}`;
}

/** 归一单条 text：非字符串/空白即空；超长截断 */
function normText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_TASK_TEXT) : '';
}

/** 全量模式：逐条清洗（空 text 丢弃、status 归一），全空则拒绝 */
function parseReplace(raw: unknown): ParsedTaskArgs {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      content: `tasks 必须是非空数组，每项形如 {"text":"...","status":"pending|in_progress|done"}。`,
    };
  }
  if (raw.length > MAX_TASK_ITEMS) {
    return {
      ok: false,
      content: `任务清单最多 ${MAX_TASK_ITEMS} 条（收到 ${raw.length} 条）：请合并或拆分粒度后再调用。`,
    };
  }
  const items: TaskItem[] = [];
  for (const it of raw) {
    const text = normText((it as { text?: unknown })?.text);
    if (!text) continue; // 空条目直接丢弃，不为它失败整单
    items.push({ text, status: normalizeTaskStatus((it as { status?: unknown })?.status) });
  }
  if (items.length === 0) {
    return { ok: false, content: 'tasks 里没有任何有效条目：每项需要非空的 text 字段。' };
  }
  return { ok: true, mode: 'replace', items };
}

/** 增量模式：只做形状解析（序号越界等与「当前清单」有关的校验留给 applyTaskPatch） */
function parsePatch(raw: unknown): ParsedTaskArgs {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      content: `updates 必须是非空数组，每项形如 {"index":1,"status":"done"}；追加新任务用 {"text":"..."}（不传 index）。`,
    };
  }
  if (raw.length > MAX_TASK_UPDATES) {
    return {
      ok: false,
      content: `一次最多更新 ${MAX_TASK_UPDATES} 条（收到 ${raw.length} 条）：改动这么多请改用 tasks 传完整清单。`,
    };
  }
  const ops: TaskPatchOp[] = [];
  for (const it of raw) {
    const o = it as { index?: unknown; text?: unknown; status?: unknown };
    const hasIndex = o?.index !== undefined && o?.index !== null;
    const text = normText(o?.text);
    const status = o?.status === 'done' || o?.status === 'in_progress' || o?.status === 'pending' ? o.status : undefined;
    const index = hasIndex ? Number(o.index) : undefined;
    if (hasIndex && (!Number.isInteger(index) || (index as number) < 1)) {
      return { ok: false, content: `index 必须是 ≥1 的整数（收到 ${String(o.index)}），序号从 1 开始。` };
    }
    if (!hasIndex && !text) {
      return { ok: false, content: '追加任务必须给出 text（不传 index 即视为追加一条新任务）。' };
    }
    if (hasIndex && !text && !status) {
      return {
        ok: false,
        content: `第 ${String(o.index)} 条没有任何改动：请给 text 或 status 至少一项，否则不要发这条。`,
      };
    }
    const op: TaskPatchOp = {};
    if (hasIndex) op.index = index;
    if (text) op.text = text;
    if (status) op.status = status;
    ops.push(op);
  }
  return { ok: true, mode: 'patch', ops };
}

/**
 * 解析工具入参 → 两种模式之一，或「怎么改对」的拒绝文案。
 * 纯函数、不触 IO；序号与「当前清单」相关的校验在 `applyTaskPatch`。
 */
export function parseTaskArgs(argsJson: string): ParsedTaskArgs {
  let raw: unknown;
  try {
    raw = JSON.parse(argsJson);
  } catch {
    return {
      ok: false,
      content:
        'update_tasks 参数不是合法 JSON：要么给 tasks=[{text,status}]（完整清单），要么给 updates=[{index,status}]（只发改动条目）。',
    };
  }
  const obj = raw as { tasks?: unknown; updates?: unknown } | null;
  const hasTasks = obj?.tasks !== undefined && obj?.tasks !== null;
  const hasUpdates = obj?.updates !== undefined && obj?.updates !== null;
  if (!hasTasks && !hasUpdates) {
    return {
      ok: false,
      content:
        'update_tasks 需要 tasks（完整清单，首次用）或 updates（增量，只发改动条目）之一：' +
        '例 {"tasks":[{"text":"查资料","status":"in_progress"}]} 或 {"updates":[{"index":1,"status":"done"}]}。',
    };
  }
  if (hasTasks && hasUpdates) {
    return {
      ok: false,
      content: 'tasks 与 updates 只能给一个：全量覆盖用 tasks，增量更新用 updates。',
    };
  }
  return hasTasks ? parseReplace(obj?.tasks) : parsePatch(obj?.updates);
}

/**
 * 把增量操作应用到当前清单（**整批原子**：任一条非法则整批不生效）。
 * 失败文案附「当前清单 + 序号」——模型据此自纠，不必先查询再重试。
 */
export function applyTaskPatch(
  current: TaskItem[],
  ops: TaskPatchOp[],
): { ok: true; items: TaskItem[] } | { ok: false; content: string } {
  const next = current.map((t) => ({ ...t })); // 不改调用方持有的数组
  const fail = (why: string): { ok: false; content: string } => ({
    ok: false,
    content:
      `${why}\n` +
      (current.length > 0 ? `当前清单：\n${renderTaskList(current)}` : '当前清单为空：请先用 tasks 参数列出完整清单。'),
  });

  // 先整体预检，再统一落地：半应用会让「模型以为的清单」与「用户看到的清单」分叉
  const projected = next.length + ops.filter((o) => o.index === undefined).length;
  if (projected > MAX_TASK_ITEMS) {
    return fail(`更新后会有 ${projected} 条，超过上限 ${MAX_TASK_ITEMS} 条：请合并粒度或先移除若干条。`);
  }
  for (const op of ops) {
    if (op.index === undefined) continue;
    if (op.index > next.length) {
      return fail(`index ${op.index} 超出范围：当前清单只有 ${next.length} 条。`);
    }
  }

  for (const op of ops) {
    if (op.index === undefined) {
      next.push({ text: op.text ?? '', status: op.status ?? 'pending' });
      continue;
    }
    const target = next[op.index - 1];
    if (!target) return fail(`index ${op.index} 超出范围：当前清单只有 ${next.length} 条。`);
    if (op.text) target.text = op.text;
    if (op.status) target.status = op.status;
  }
  return { ok: true, items: next };
}
