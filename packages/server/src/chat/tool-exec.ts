/**
 * chat/tool-exec —— 单轮工具调用的调度策略：并行 + 超时 + 取消（契约 `docs/TOOL-ECOSYSTEM-SPEC.md` §4.3 第 1/2/3 条）。
 *
 * 过渡定位：契约 S1 的终态是 `chat/tools/registry.ts`（注册表拆目录）。本文件是「先把执行策略落地」
 * 的一步，拆目录时整体搬进去 —— **不在别处再写第二份**（指针原则：只留一处事实）。
 *
 * 能力边界（如实标注，不假装做全）：
 * - 并行：`Promise.allSettled`，结果**按调用顺序**回灌（顺序稳定性＝回归锁可钉）。
 * - 超时：到点后不再等待、不把结果回灌；被放弃的那次调用仍在后台跑完——
 *   真正的中断需要 `signal` 透传进工具内部（改 `ToolContext`，下一步，本批不做）。
 * - 取消：中止后**不再干等**，立刻按「已停止」结算（见 `abortRaceOf`）；已在跑的调用同样只是「不等它」。
 * - 未做（需要 `kind` 字段，属 S1 后半）：同轮去重、network 失败重试 1 次。
 *
 * 为什么 exec 走参数注入而不是直接 import：`runTool` 会碰 DB 与网络，
 * 注入后本文件的策略逻辑可以零 mock 单测（改的是计时与顺序，mock 模块反而测不准）。
 */
import type { ToolCall } from '../llm/types.js';
import type { ToolContext, ToolResult } from './tools.js';
import { runTool } from './tools.js';

export type ToolExecFn = (name: string, argsJson: string, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolOutcome {
  id: string;
  name: string;
  /** 回灌给模型的内容：成功是工具返回，失败是「怎么改对」的指示（契约 §4.2 纠错口径） */
  content: string;
  ok: boolean;
}

export interface ToolExecOptions {
  /** 单工具超时，缺省 30s（契约 §4.2 默认；network/external 的 15s 待 kind 字段落地后再分档） */
  timeoutMs?: number;
  /** 执行器注入点，缺省用真实 runTool */
  exec?: ToolExecFn;
  signal?: AbortSignal;
}

/** 过程卡片可展开的载荷（SSE 契约 2026-09-09）：入参原文 + 结果摘要 */
export interface StepPayload {
  args?: string;
  result?: string;
}

/** 结果摘要截断上限：给用户点开看的，不是回灌模型的（回灌另有 MAX_TOOL_RESULT_CHARS） */
export const RESULT_SNIPPET_CHARS = 400;

/** 契约 §4.2 默认超时。搜网免 key 兜底已知可挂 ~20s，30s 是「给它跑完但别拖死一轮」的折中 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** 超时回灌：明确禁止模型重复调用（小模型最爱原地重试，一重试就再等一个超时） */
export const TIMEOUT_HINT = '本工具超时，请勿重复调用同一工具，改为直接作答。';
/** 中止回灌：同样是「别再调了」，但归因给用户，便于模型给出得体的收尾 */
export const ABORT_HINT = '用户已停止本次生成，不要再调用工具，改为直接作答。';

export class ToolTimeoutError extends Error {
  constructor(ms: number) {
    super(`工具执行超时（${ms}ms）`);
    this.name = 'ToolTimeoutError';
  }
}

/**
 * 把 signal 变成可参与 race 的 promise。
 *
 * 为什么要 `done` 这个内部 controller：race 结束后这个 promise 会**永远 pending**，
 * 而留着 pending promise 会拖住 vitest 的 worker（表现为 worker 层面莫名其妙的栈溢出，
 * 与本文件逻辑无关、极难定位）。故调用结束时由 `done` 主动结算掉它；
 * 那次结算走 reject，用 `p.catch` 兜住，不让它冒成 unhandled rejection。
 */
function abortRaceOf(signal: AbortSignal | undefined, done: AbortController): Promise<never> | null {
  if (!signal) return null;
  const p = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new Error('已停止'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    done.signal.addEventListener(
      'abort',
      () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('__settled__'));
      },
      { once: true },
    );
  });
  p.catch(() => undefined);
  return p;
}

/**
 * 步骤发射器的宽松口径：比 tools.ts 的 ToolContext.onStep 多一个可选 payload——
 * 本文件要在终态事件上附 args/result。3 参的 onStep（工具实现、测试桩）照样可赋值进来。
 */
export interface StepEmitterCtx {
  onStep: (tool: string, status: 'running' | 'done' | 'error', detail?: string, payload?: StepPayload) => void;
}

/**
 * 并行执行一轮内的全部工具调用，返回与入参同序的结果。
 * 单个工具失败/超时/被取消都**不抛**——各自的失败以 `content` 回灌模型自纠（契约 §4.2），
 * 只有调度器本身炸了才进 allSettled 的兜底分支（那属于 bug，不静默吞）。
 */
export async function runToolCalls(
  calls: ToolCall[],
  ctx: StepEmitterCtx,
  opts: ToolExecOptions = {},
): Promise<ToolOutcome[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const exec = opts.exec ?? runTool;
  const signal = opts.signal;
  const done = new AbortController();
  const abortRace = abortRaceOf(signal, done);

  try {
    const tasks = calls.map(async (call) => {
      if (signal?.aborted) {
        ctx.onStep(call.name, 'error', '已停止');
        return { id: call.id, name: call.name, content: ABORT_HINT, ok: false };
      }

      /**
       * 终态接管：工具实现（tools.ts）内部会自己发 done/error，这里**拦下缓存、
       * 不直接透出**，等 race 出结果后由本调度器统一重发一次并附上 args/result 载荷——
       * 保证每张过程卡片有且只有一个终态，且点开能看到输入输出（SSE 契约 2026-09-09）。
       * running 原样透传（过程态要实时）。
       */
      let terminal: { status: 'done' | 'error'; detail?: string } | undefined;
      const callCtx: ToolContext = {
        onStep: (tool, status, detail) => {
          if (status === 'running') {
            ctx.onStep(tool, 'running', detail);
            return;
          }
          terminal = { status, detail };
        },
      };

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const racers: Array<Promise<ToolResult>> = [exec(call.name, call.arguments, callCtx)];
        racers.push(
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ToolTimeoutError(timeoutMs)), timeoutMs);
          }),
        );
        if (abortRace) racers.push(abortRace);
        const r = await Promise.race(racers);
        // 工具内部已自判 error 却正常返回（如搜索词为空）：如实重发 error，不再补 done
        if (terminal?.status === 'error') {
          ctx.onStep(call.name, 'error', terminal.detail, { args: call.arguments });
        } else {
          ctx.onStep(call.name, 'done', terminal?.detail, {
            args: call.arguments,
            result: r.content.slice(0, RESULT_SNIPPET_CHARS),
          });
        }
        return { id: call.id, name: call.name, content: r.content, ok: true };
      } catch (err) {
        const aborted = signal?.aborted === true;
        const timedOut = err instanceof ToolTimeoutError;
        const detail = aborted
          ? '已停止'
          : timedOut
            ? `超时 ${timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err);
        ctx.onStep(call.name, 'error', detail, { args: call.arguments });
        return {
          id: call.id,
          name: call.name,
          content: aborted ? ABORT_HINT : timedOut ? TIMEOUT_HINT : `工具执行失败：${detail}`,
          ok: false,
        };
      } finally {
        // 必须清：不清的话每个工具都会挂一个 timer 拖到超时点，Node 进程退出被推迟
        if (timer) clearTimeout(timer);
      }
    });

    const settled = await Promise.allSettled(tasks);
    return settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            id: calls[i]?.id ?? '',
            name: calls[i]?.name ?? '',
            content: `工具执行失败：${String(s.reason)}`,
            ok: false,
          },
    );
  } finally {
    done.abort(); // 结算 abortRace，不留 pending promise
  }
}
