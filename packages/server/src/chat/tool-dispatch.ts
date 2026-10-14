/**
 * chat/tool-dispatch —— 单轮工具循环的「执行器装配」（2026-09-19 从 flow.ts 原样搬出，零行为改动）。
 *
 * 为什么搬：flow.ts 加计时线后 410/400 破线，按仓规**拆文件不压注释**（先例 persist.ts 同因搬出）。
 * 搬的是内聚的一块：`update_tasks` 的清单合并语义 + 非清单工具转发 `runTool` + grill 开场打 pre 标记。
 *
 * ★ `update_tasks` 刻意**不进注册表（`chat/tools/`）**：它带每轮清单状态，与注册表工具的
 *   无状态签名不同接缝（原「避让 tools.ts」的理由已随 2026-09-19 拆目录消失，接入方式
 *   口径保持不变）：definition 由调用方拼进 tools 列表，执行走 runToolCalls 的 exec 注入点。
 * ★ 清单状态走 `getTasks/setTasks` 闭包注入而非本文件持有：归属权仍在 flow.ts 的 `latestTasks`
 *   （收口落库读的是同一份），这里只是唯一写口。
 */
import { publish } from './sse-bus.js';
import { runTool } from './tools/index.js';
import type { ToolContext, ToolResult } from './tools/index.js';
import { parseTaskArgs, applyTaskPatch, formatTaskList, type TaskItem } from './task-list.js';
import { DESKTOP_FILE_TOOL_NAMES, executeDesktopChatTool } from '../desktop/chat-integration.js';
import { patchDesktopRun } from '../desktop/task-store.js';
import { executePluginChatTool, PLUGIN_TOOL_NAMES } from '../plugins/chat.js';
import { recordRunEvent } from '../desktop/task-store.js';
import { discoverExamResources } from './exam-resource-discovery.js';
import { executeLearningVideoTool } from './learning-video-tools.js';

export function createExecTool(deps: {
  sessionId: string;
  desktopTaskId?: string;
  examDiscoveryAllowed?: boolean;
  /** grill-me 开场：给强绑产生的 ask_choice 打 pre 标记，前端据此把它沉进消息流（普通触发不带） */
  grill: boolean;
  getTasks: () => TaskItem[];
  setTasks: (items: TaskItem[]) => void;
}): (name: string, argsJson: string, ctx: ToolContext) => Promise<ToolResult> {
  const { sessionId, grill, getTasks, setTasks } = deps;
  const discovered = new Set<string>();
  /**
   * 任务清单工具执行器：两种模式（全量 tasks / 增量 updates）→ 合并当前清单 →
   * 发 tasks 事件（**恒为完整清单**，前端整表替换）→ 回灌带序号的清单确认。
   * 回灌必须带序号：patch 模式靠 index 定位，模型看不到序号下一次就会错位。
   */
  return async (name, argsJson, ctx) => {
    if (name === 'search_learning_videos' || name === 'curate_learning_videos') return executeLearningVideoTool(name,argsJson,ctx);
    if (name === 'discover_exam_resources') {
      if (!deps.examDiscoveryAllowed) return {content:'本轮没有补充应试资源的明确请求，请使用受原范围限制的普通检索。'};
      const result = await discoverExamResources(argsJson, ctx);
      const found = JSON.parse(result.content) as {candidates:Array<{host:string;verified:boolean}>};
      for (const c of found.candidates) if (c.verified) discovered.add(c.host);
      return result;
    }
    if (name === 'update_exam_scope' && deps.examDiscoveryAllowed) {
      const args = JSON.parse(argsJson) as {addHosts?:unknown;setHosts?:unknown};
      const hosts = [args.addHosts,args.setHosts].flatMap(v => Array.isArray(v) ? v : []);
      if (hosts.some(h => typeof h !== 'string' || !discovered.has(h.toLowerCase()))) return {content:'白名单未修改：新增资源站必须先由 discover_exam_resources 验证；未搜到则如实说明，不编造域名。'};
    }
    if (PLUGIN_TOOL_NAMES.includes(name)) {
      if (deps.desktopTaskId) recordRunEvent(deps.desktopTaskId, ctx.ownerId, '调用插件：' + name);
      return executePluginChatTool(name, argsJson, ctx);
    }
    if (DESKTOP_FILE_TOOL_NAMES.includes(name)) return executeDesktopChatTool(name, argsJson, ctx, deps.desktopTaskId).catch(error => ({ content: `操作未完成：${error instanceof Error ? error.message : String(error)}` }));
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
    if (deps.desktopTaskId) patchDesktopRun(deps.desktopTaskId, ctx.ownerId, { tasks: getTasks() });
    return Promise.resolve({ content: formatTaskList(getTasks()) });
  };
}
