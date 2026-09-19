/**
 * chat/tools/registry —— 工具注册表（契约 `docs/TOOL-ECOSYSTEM-SPEC.md` §4.1/§4.2，S1 内核）。
 *
 * 单一事实源：工具清单只有一个 `registry` Map；`web-search.ts` / `term-tidy.ts` / `term-manage.ts`
 * 各自 `registerTool()` 完成注册，`index.ts` 负责触发注册副作用并对外 re-export——
 * 消费者（flow / grill / tool-exec / routes）只 import index，不开第二份清单。
 *
 * §4.2 新增元数据字段（kind/timeoutMs/idempotent/scenes/needsConfirm）在此声明：
 * - `kind` 必填——它是分档超时（tool-exec）、同轮重试（network+idempotent）、
 *   确认门缺省（P3）三个消费方的共同事实源，漏声明 = 编译期报错。
 * - `needsConfirm` P2 只落类型不生效（P3 接确认门），避免半条链路。
 */
import type { ToolDefinition } from '../../llm/types.js';
import type { ConfirmPolicy, GrillPhase, ModelRole, ToolKind } from '@sb/shared';
import { MAX_DISPATCHED_TOOLS } from '@sb/shared';
import { validateToolArgs } from './schema.js';

export interface ToolContext {
  /** 工具步骤回调（step 事件上屏） */
  onStep: (tool: string, status: 'running' | 'done' | 'error', detail?: string) => void;
  /**
   * 会话级中止信号（v13 体验升级）：透传进工具内部 fetch，「停止生成」真掐断联网请求，
   * 不再只是把结果丢弃后干等超时。工具实现自行与本地超时合并（search 用 AbortSignal.any）。
   */
  signal?: AbortSignal;
  /**
   * 所属会话 id（2026-09-14，方案选择框）：`ask_choice` 要把提问绑到当前会话，答复才能续回这一轮。
   * 可选——不依赖会话的工具（搜索 / 词条）无需关心它，既有工具桩也不必改。
   */
  sessionId?: string;
  /**
   * grill-me 阶段（v18）：有值表示这次 `ask_choice` 是 grill-me 强绑产生的，
   * 会随提问一起下发，前端据此决定「选完是续本轮还是开新一轮」。普通触发不带。
   */
  grillPhase?: GrillPhase;
  /**
   * 归属用户 id（M2c 起；契约 `docs/TENANCY-SPEC.md` §8.1.4 / §8.2）。
   *
   * ★ v31（M2d-2）起**必填**（`string | null`，不给可选）——原注释写"不碰模型的工具
   *   （搜索 / 词条增删）无需关心它"，那在 `term_library` 还是全局表时成立；
   *   **归主之后词条增删改查本身就是归属操作**（漏传 = 写进无主行 / 读到别人的词条），
   *   故与 `tidy_terms` 的 auto 分支同等需要它。`null` = 未登录单人模式（落无主行）。
   *   ★ 改必填时实测逮到一处真漏点：`chat/flow.ts` 的主对话路径**此前根本没传**
   *     （`runToolCalls(…)` 的 opts 里没有 `ownerId`）⇒ `tidy_terms` 的 auto 分支
   *     一直在把模型调用记到平台头上。这正是"必填"要防的那类静默错误。
   */
  ownerId: string | null;
}

export interface ToolResult {
  /** 回灌给模型的 tool 消息内容 */
  content: string;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** 工具类别：分档超时 / 重试资格 / 确认门缺省的共同事实源（§4.2） */
  kind: ToolKind;
  /**
   * 逐工具显式超时，覆盖 `KIND_TIMEOUT_MS[kind]` 档位。
   * 只给「内部再调 LLM」的工具（如 `tidy_terms` auto 分支 = `TOOL_LLM_INNER_TIMEOUT_MS`）；
   * 档位基线不因个别慢工具上调（v1.3 拍板⑪）。
   */
  timeoutMs?: number;
  /** 同参重放无副作用——network 失败重试 1 次的资格要件（§4.3-5，与 kind='network' 同时成立才重试） */
  idempotent?: boolean;
  /**
   * 确认门策略（§4.6）。**P2 只落类型，P3 才生效**——
   * 届时缺省 read/network=false、write='by_size'、external=true。
   */
  needsConfirm?: ConfirmPolicy;
  /** 场景裁剪（§4.4）：不给 = 全场景下发；给 = 仅列出的模型角色下发。P2 现役工具均不限场景 */
  scenes?: ModelRole[];
}

const registry = new Map<string, RegisteredTool>();

/** 注册入口（工具实现文件在模块加载时调用；index.ts 的 import 顺序即注册顺序） */
export function registerTool(name: string, tool: RegisteredTool): void {
  if (registry.has(name)) {
    throw new Error(`工具重复注册：${name}（单一注册入口，检查是否有文件绕过 index 直接 import registry）`);
  }
  registry.set(name, tool);
}

/** 元数据读取：tool-exec 调度器据此做分档超时 / 重试资格判定 */
export function toolMeta(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

/**
 * 下发给模型的工具清单。
 * `role`（§4.4 场景裁剪）：不给 = 全量；给 = 内建（无 scenes）+ 声明了该场景的工具。
 * 超 `MAX_DISPATCHED_TOOLS` 按声明顺序截断——截断是事实，不静默：控制台留一行警告（ADR-5）。
 */
export function toolDefinitions(role?: ModelRole): ToolDefinition[] {
  const all = [...registry.values()];
  const scoped = role ? all.filter((t) => !t.scenes || t.scenes.includes(role)) : all;
  const dispatched = scoped.slice(0, MAX_DISPATCHED_TOOLS);
  if (dispatched.length < scoped.length) {
    console.warn(
      `[tools] 下发清单超限截断：${scoped.length} → ${MAX_DISPATCHED_TOOLS}（裁剪口径见契约 §4.4，被截: ${scoped
        .slice(MAX_DISPATCHED_TOOLS)
        .map((t) => t.definition.function.name)
        .join(', ')}）`,
    );
  }
  return dispatched.map((t) => t.definition);
}

export function toolNames(): string[] {
  return [...registry.keys()];
}

export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    ctx.onStep(name, 'error', '未知工具');
    return { content: `未知工具：${name}` };
  }
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    ctx.onStep(name, 'error', '参数 JSON 解析失败');
    return { content: '工具参数 JSON 解析失败' };
  }
  // §4.2 参数预闸：违例不执行工具，回灌「怎么改对」让模型自纠（AI SDK invalid_tool_error 同型）。
  // 拦截发生在工具体之前，所以工具体内的手工校验仍是兜底（两者口径以 definition 为准）。
  const hint = validateToolArgs(name, args, tool.definition.function.parameters);
  if (hint) {
    ctx.onStep(name, 'error', '参数校验失败');
    return { content: hint };
  }
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    ctx.onStep(name, 'error', err instanceof Error ? err.message : String(err));
    return { content: `工具执行失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
