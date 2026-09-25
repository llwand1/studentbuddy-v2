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
import './fetch-page.js';
import './fetch-image.js';
import './term-tidy.js';
// 出题工具化（2026-09-23）：把 `routes/quiz.ts` 那条 REST 引擎接进模型手里
import './generate-quiz.js';
// P3 拍板⑭：term-manage（manage_terms 四合一裸写口）退役，词条写门面收进 term-ops 三工具
import './term-ops.js';
// §16（2026-09-24）：AI 主动发起对战——邀请只能由模型的工具发出，**没有** REST 创建口，
// 所以这一行 import 就是那张卡片的唯一来源（漏挂的症状＝「AI 嘴上说要打，屏上没有卡」）
import './offer-pk-battle.js';

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
