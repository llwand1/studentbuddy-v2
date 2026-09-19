/**
 * chat/tools/index —— 注册触发点 + 对外门面（契约 `docs/TOOL-ECOSYSTEM-SPEC.md` §4.1）。
 *
 * 职责边界：本文件**只**做两件事——
 * ① import 各工具文件触发注册副作用（顺序即下发顺序，与拆分前 `chat/tools.ts` 一致）；
 * ② re-export registry 的对外门面（toolDefinitions/toolNames/runTool/…），
 *    消费者一律 `from './tools/index.js'`，不直捅子模块——门面换实现不外泄。
 *
 * `ask_choice` 在 index 注册而不是自注册文件：它的定义在 `chat/choice-tool.ts`
 * （长时间挂起的例外，独立成文件的理由写在那边），这里补上注册那一步，保持单一注册入口。
 */
import { CHOICE_TOOL, runChoiceTool } from '../choice-tool.js';
import { registerTool } from './registry.js';
import './web-search.js';
import './term-tidy.js';
// P3 拍板⑭：term-manage（manage_terms 四合一裸写口）退役，词条写门面收进 term-ops 三工具
import './term-ops.js';

// §4.2 元数据：对模型是「读一个决策」、对系统是挂起等待——kind 'read'（30s 档）。
// 但等待时长取决于人 not 机器，**30s 档照样会掐死它**：豁免靠 tool-exec 的 `noTimeout`
// 名单（flow.ts 传 `['ask_choice']`），不靠调档位——这是 v1.3 拍板里明确保留的例外。
registerTool('ask_choice', {
  definition: CHOICE_TOOL,
  run: (args, ctx) => runChoiceTool(args, ctx),
  kind: 'read',
});

export { toolDefinitions, toolNames, runTool, toolMeta, registerTool } from './registry.js';
export type { ToolContext, ToolResult, RegisteredTool, PendingWrite } from './registry.js';
export { toolDefinitionTokens } from './budget.js';
