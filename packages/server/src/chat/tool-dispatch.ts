/**
 * chat/tool-dispatch —— 单轮工具循环的「执行器装配」（2026-09-19 P1 从 flow.ts 原样搬出，零行为改动）。
 *
 * 为什么搬：flow.ts 加计时线后 410/400 破线，按仓规**拆文件不压注释**（先例 persist.ts 同因搬出）。
 * 搬的是内聚的一块：`update_tasks` 的清单合并语义 + 非清单工具转发 `runTool` + grill 开场打 pre 标记。
 *
 * ★ `update_tasks` 刻意**不进 tools.ts 注册表**（该文件常有并行会话在途改动，R1 避让）：
 *   definition 由调用方拼进 tools 列表，执行走 runToolCalls 的 exec 注入点——零改动 tools.ts。
 * ★ 清单状态走 `getTasks/setTasks` 闭包注入而非本文件持有：归属权仍在 flow.ts 的 `latestTasks`
 *   （收口落库读的是同一份），这里只是唯一写口。
 */
import { publish } from './sse-bus.js';
import { runTool } from './tools.js';
import type { ToolContext, ToolResult } from './tools.js';
import { parseTaskArgs, applyTaskPatch, formatTaskList, type TaskItem } from './task-list.js';

export function createExecTool(deps: {
  sessionId: string;
  /** grill-me 开场：给强绑产生的 ask_choice 打 pre 标记，前端据此把它沉进消息流（普通触发不带） */
  grill: boolean;
  getTasks: () => TaskItem[];
  setTasks: (items: TaskItem[]) => void;
}): (name: string, argsJson: string, ctx: ToolContext) => Promise<ToolResult> {
  const { sessionId, grill, getTasks, setTasks } = deps;
  /**
   * 任务清单工具执行器：两种模式（全量 tasks / 增量 updates）→ 合并当前清单 →
   * 发 tasks 事件（**恒为完整清单**，前端整表替换）→ 回灌带序号的清单确认。
   * 回灌必须带序号：patch 模式靠 index 定位，模型看不到序号下一次就会错位。
   */
  return (name, argsJson, ctx) => {
    if (name !== 'update_tasks') {
      return runTool(name, argsJson, name === 'ask_choice' && grill ? { ...ctx, grillPhase: 'pre' } : ctx);
    }
    const parsed = parseTaskArgs(argsJson);
    if (!parsed.ok) return Promise.resolve({ content: parsed.content });
    if (parsed.mode === 'replace') {
      setTasks(parsed.items);
    } else {
      const applied = applyTaskPatch(getTasks(), parsed.ops);
      // 整批原子：任一条非法就整批不生效，把「当前清单 + 序号」回灌给模型自纠
      if (!applied.ok) return Promise.resolve({ content: applied.content });
      setTasks(applied.items);
    }
    publish(sessionId, { type: 'tasks', sessionId, items: getTasks() });
    return Promise.resolve({ content: formatTaskList(getTasks()) });
  };
}
