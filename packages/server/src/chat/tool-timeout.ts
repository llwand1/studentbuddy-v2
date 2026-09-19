/**
 * chat/tool-timeout —— 单工具超时的**档位解析**（契约 TOOL-ECOSYSTEM-SPEC §4.2/§4.3-2，
 * v1.3 拍板⑪；2026-09-19 P3 从 tool-exec.ts 拆出，先例 tool-dispatch.ts 同因：
 * 调度器文件堆到 404/400，照仓规**拆文件不压注释**）。
 *
 * 为什么单独成文件而不是留在调度器：档位判定是**纯查表 + 一条加余量规则**，零计时零 mock，
 * 它的回归测试（`tool-exec.test.ts` 的分档用例）测的根本不是调度器。接缝用 re-export 保住
 * 既有导入面——`tool-exec.test.ts` 的 `import { resolveToolTimeoutMs } from './tool-exec.js'`
 * 一个字不用改（同 `learning/terms.ts` 的做法）。
 */
import { KIND_TIMEOUT_MS, CONFIRM_TIMEOUT_MS } from '@sb/shared';
import { toolMeta } from './tools/index.js';

/** 全局缺省超时（注册表查不到元数据时兜底）。分档见 `KIND_TIMEOUT_MS`（@sb/shared） */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`工具执行超时（${ms}ms）`);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * 单工具超时解析（§4.2 分档，v1.3 拍板⑪）：显式 `opts.timeoutMs` ＞ 注册表逐工具 `timeoutMs`
 * ＞ `KIND_TIMEOUT_MS[kind]` ＞ 全局缺省 30s。未注册名（exec 桩）落全局缺省。
 * 单独导出是为了让档位判定可零计时单测——真等 60s/120s 的断言不配进回归。
 */
export function resolveToolTimeoutMs(name: string, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const meta = toolMeta(name);
  if (!meta) return DEFAULT_TOOL_TIMEOUT_MS;
  const base = meta.timeoutMs ?? KIND_TIMEOUT_MS[meta.kind];
  /**
   * P3 确认门余量：`planWrite` 且未被显式免确认的工具，档位上再加一个 `CONFIRM_TIMEOUT_MS`。
   * 理由：人点确认卡最多挂 60s（§6.3-4 的代答发生在**这次调用内部**），write 档 30s 会在
   * 用户还没抬手时就掐死等待并回灌超时——确认门等于废掉。`tidy_terms` 的 120s 显式值
   * 同样要加（先等模型出方案、再等人批准，两段各花各的）。免确认档（needsConfirm=false）不加，
   * 没有人的等待就不该占机器的预算。
   */
  return meta.planWrite && meta.needsConfirm !== false ? base + CONFIRM_TIMEOUT_MS : base;
}
