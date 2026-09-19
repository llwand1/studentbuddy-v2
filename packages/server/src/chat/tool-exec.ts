/**
 * chat/tool-exec —— 单轮工具调用的调度策略：并行 + 分档超时 + 取消 + 同轮去重 + network 重试。
 * （契约 `docs/TOOL-ECOSYSTEM-SPEC.md` §4.3 全部 5 条；S1 落地批 2026-09-19）
 *
 * 能力边界（如实标注，不假装做全）：
 * - 并行：`Promise.allSettled`，结果**按调用顺序**回灌（顺序稳定性＝回归锁可钉）。
 * - 分档超时（§4.2/拍板⑪）：每工具按 `opts.timeoutMs`（显式，测试桩/调用方覆盖）＞
 *   注册表逐工具 `timeoutMs`（如 `tidy_terms` 内部调模型 120s）＞ `KIND_TIMEOUT_MS[kind]`
 *   （read/write 30s、network/external 60s）＞ 全局缺省 30s 取第一个命中的。
 *   未注册名（exec 桩）落全局缺省——分档只对真实注册工具生效。
 *   P3 加一条**确认门余量**（`planWrite` 且非免确认 ⇒ 档位 +`CONFIRM_TIMEOUT_MS`，人点卡的
 *   60s 挂起发生在这次调用内部）。档位解析已拆到 `tool-timeout.ts`（本文件触 400 红线，
 *   仓规拆文件不压注释），此处 re-export 保住既有导入面。
 * - 统计单点（§4.5，v1.4 拍板⑰）：真实执行完的调用在这里发一条 `tool_called` 领域事件，
 *   落库归订阅方 `storage/tool-stats.ts`——本文件因此**依然不碰 DB**（测试边界不破，见头注）。
 * - 取消：中止后**不再干等**，立刻按「已停止」结算（见 `abortRaceOf`）；已在跑的调用同样只是「不等它」。
 *   被放弃的那次调用仍在后台跑完——中断路径（v13 起）已把 `signal` 透传进 `ToolContext`，
 *   联网工具内部 fetch 真被掐断，「停止生成」不再干等；非联网工具（DB 类）本身秒回，无需取消。
 * - 同轮去重（§4.3-4）：`name + canonicalToolArgs(arguments)` 相同的调用只执行一次，
 *   后来者复用首个结果并**各发自己的终态卡**（toolCallId 各归各，B-010 配对不破）。
 * - 失败重试（§4.3-5）：仅 `kind:'network'` 且 `idempotent` 的工具，异常/超时静默重试 1 次；
 *   中止**不重试**；write/read/external 不重试（重放可能有副作用）。重试对用户不可见：
 *   不再发第二张 running 卡（B-010 配对下会开新卡），整次调用只有一个终态帧。
 *
 * 为什么 exec 走参数注入而不是直接 import：`runTool` 会碰 DB 与网络，
 * 注入后本文件的策略逻辑可以零 mock 单测（改的是计时与顺序，mock 模块反而测不准）。
 * 注意：重试/分档资格查的是**真实注册表元数据**（toolMeta），与 exec 是否被注入无关——
 * 测试用真实工具名 + 假 exec 即可驱动这两条策略。
 */
import type { ToolCall } from '../llm/types.js';
import type { ToolConfirmDecision } from '@sb/shared';
import type { ToolContext, ToolResult } from './tools/registry.js';
import { runTool, toolMeta } from './tools/index.js';
import { publishEvent } from '../events/bus.js';
import { canonicalToolArgs } from '@sb/shared';
import { DEFAULT_TOOL_TIMEOUT_MS, ToolTimeoutError, resolveToolTimeoutMs } from './tool-timeout.js';

// 档位解析已拆到 `tool-timeout.ts`（本文件 404/400 触线，仓规拆文件）；re-export 保住
// 既有导入面——`tool-exec.test.ts` 的分档用例、未来 flow 侧的引用都不用改 import 路径。
export { DEFAULT_TOOL_TIMEOUT_MS, ToolTimeoutError, resolveToolTimeoutMs } from './tool-timeout.js';

export type ToolExecFn = (name: string, argsJson: string, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolOutcome {
  id: string;
  name: string;
  /** 回灌给模型的内容：成功是工具返回，失败是「怎么改对」的指示（契约 §4.2 纠错口径） */
  content: string;
  ok: boolean;
  /**
   * 服务端实测执行耗时（ms），随消息落库（`messages.duration_ms`，迁移 v32）。
   * `undefined` 只有一种来源：**进入执行前就已中止**——那次调用没跑过，落 0 是谎话
   * （§4.7：耗时缺失退「无时长」而不是「0 秒」，存储侧同口径留 NULL）。
   */
  durationMs?: number;
  /**
   * P3（§4.5/§4.2）：write-gate 注回的审计元数据，本文件**只搬运不解读**——
   * 终态后原样进 `tool_called` 事件（订阅方落 `tool_stats`）。读/网络工具不填＝null。
   */
  meta?: { affected?: number | null; confirm?: ToolConfirmDecision | null };
  /**
   * 同轮去重复用标记：这条 outcome 没有自己的执行（复用了首个调用的结果），
   * 统计事件也随之**不发**——一次执行记两笔会把失败率算假。
   */
  reused?: boolean;
}

export interface ToolExecOptions {
  /**
   * 本轮统一的显式超时，优先级最高（覆盖注册表分档）。生产调用方不传；
   * 留给测试桩与「这一轮就是要短」的特殊编排用。
   */
  timeoutMs?: number;
  /**
   * 不参与超时的工具名（长等待类）。`ask_choice` 要等学习者点选，可能远超任何档位，
   * 且**契约不设超时**（老板拍板：不选就一直等）——给它挂 timer 会直接掐断等待
   * 并回灌「本工具超时，请勿重复调用」，功能等于废掉。豁免的工具仍受 abort 约束
   * （「停止生成」照样能解除挂起），只是不再被时间淘汰。
   */
  noTimeout?: string[];
  /** 执行器注入点，缺省用真实 runTool */
  exec?: ToolExecFn;
  signal?: AbortSignal;
  /** 透传进 ToolContext 的会话 id（需要绑会话的工具用，如 ask_choice） */
  sessionId?: string;
  /**
   * 透传进 ToolContext 的归属用户 id（M2c 起；**v31 起必填**）。
   * ★ 必填的理由：`upsert_term`/`delete_terms`（P3 起接替 manage_terms 的词条写门面）
   *   与 `tidy_terms` 都要按人读写；
   *   漏传的表现是"写进无主行 / 读到别人的词条"，**全程不报错**。
   * ★ 改必填时实测逮到 `chat/flow.ts` 主对话路径根本没传（同 `tools.ts` 那处注释）。
   */
  ownerId: string | null;
}

/**
 * 过程卡片可展开的载荷（SSE 契约 2026-09-09）：入参原文 + 结果摘要。
 * ★ P1（2026-09-19，契约 TOOL-ECOSYSTEM-SPEC §4.7）扩三字段，**全部由本文件的调度器统一注入**——
 *   工具实现（chat/tools/）与消费面（flow/grill 的 onStep）都不碰它们：注入点只有一处，
 *   漏注入 = 编译期可查，而"各调用点自己记得带"就是这次 B-009 之前 `ownerId` 漏传的形态。
 */
export interface StepPayload {
  args?: string;
  result?: string;
  /** 模型侧 call id：同名并行调用据此配对卡片，替代前端「name+running 倒扫」（会串卡） */
  toolCallId?: string;
  /** 服务端实测执行耗时（ms），仅终态帧携带 */
  durationMs?: number;
  /** error 终态的人读错误（对齐 AI SDK output-error.errorText）：与 result 互斥 */
  errorText?: string;
}

/** 结果摘要截断上限：给用户点开看的，不是回灌模型的（回灌另有 MAX_TOOL_RESULT_CHARS） */
export const RESULT_SNIPPET_CHARS = 400;

/** 超时回灌：明确禁止模型重复调用同一工具（小模型最爱原地重试，一重试就再等一个超时）。
 *  注意与调度器自身的静默重试不冲突：重试发生在回灌之前，模型永远看不到中间那次 */
export const TIMEOUT_HINT = '本工具超时，请勿重复调用同一工具，改为直接作答。';
/** 中止回灌：同样是「别再调了」，但归因给用户，便于模型给出得体的收尾 */
export const ABORT_HINT = '用户已停止本次生成，不要再调用工具，改为直接作答。';

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
 * 步骤发射器的宽松口径：比 tools/registry 的 ToolContext.onStep 多一个可选 payload——
 * 本文件要在终态事件上附 args/result。3 参的 onStep（工具实现、测试桩）照样可赋值进来。
 */
export interface StepEmitterCtx {
  onStep: (tool: string, status: 'running' | 'done' | 'error', detail?: string, payload?: StepPayload) => void;
}

/** 一次调用的终态画像：供同轮去重的复用方重放自己的卡片（outcome 之外还要 step 的形状） */
interface StepInfo {
  status: 'done' | 'error';
  detail?: string;
  result?: string;
  errorText?: string;
  durationMs?: number;
}

interface ExecResult {
  outcome: ToolOutcome;
  step: StepInfo;
}

/**
 * 并行执行一轮内的全部工具调用，返回与入参同序的结果。
 * 单个工具失败/超时/被取消都**不抛**——各自的失败以 `content` 回灌模型自纠（契约 §4.2），
 * 只有调度器本身炸了才进 allSettled 的兜底分支（那属于 bug，不静默吞）。
 *
 * ★ `opts` **没有默认值**（M2d-2 起）：原写法 `opts: ToolExecOptions = {}` 会让
 *   「漏传 ownerId」在编译期看不出来，而 `ToolExecOptions.ownerId` 已改必填
 *   （词条增删改查自 v31 起就是归属操作）。去掉默认值后，**每个调用点都被 `tsc` 点名**
 *   ——`chat/flow.ts` 那处漏点就是这么被逮到的。
 */
export async function runToolCalls(calls: ToolCall[], ctx: StepEmitterCtx, opts: ToolExecOptions): Promise<ToolOutcome[]> {
  const exec = opts.exec ?? runTool;
  const signal = opts.signal;
  const noTimeout = opts.noTimeout ?? [];
  const done = new AbortController();
  const abortRace = abortRaceOf(signal, done);

  try {
    /** 同轮去重表：key=name+归一化参数，后来者挂到首个调用的 promise 上复用结果 */
    const inflight = new Map<string, Promise<ExecResult>>();
    const tasks = calls.map((call) => {
      const key = `${call.name}|${canonicalToolArgs(call.arguments)}`;
      const first = inflight.get(key);
      if (first) return reuseFirst(ctx, first, call);
      const p = execute(call, exec, ctx, opts, signal, noTimeout, abortRace);
      inflight.set(key, p);
      return p;
    });

    const settled = await Promise.allSettled(tasks);
    const outcomes = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value.outcome
        : {
            id: calls[i]?.id ?? '',
            name: calls[i]?.name ?? '',
            content: `工具执行失败：${String(s.reason)}`,
            ok: false,
          },
    );
    // 统计单点（§4.5，v1.4 拍板⑰）：全仓唯一的 `tool_called` 发布处。
    // `durationMs === undefined` ＝ 进执行前已中止（没跑过，没什么可统计）；
    // `reused` ＝ 同轮去重复用（真实执行已在首个调用记过一笔）。两者都不发，宁缺不假。
    for (const o of outcomes) if (o.durationMs !== undefined && !o.reused) publishToolStat(o, opts);
    return outcomes;
  } finally {
    done.abort(); // 结算 abortRace，不留 pending promise
  }
}

/** 组一条 `tool_called` 事件。落库在订阅方（storage/tool-stats.ts），这里只管如实报数 */
function publishToolStat(o: ToolOutcome, opts: ToolExecOptions): void {
  const meta = toolMeta(o.name);
  publishEvent({
    type: 'tool_called',
    sessionId: opts.sessionId ?? null,
    ownerId: opts.ownerId,
    tool: o.name,
    source: meta?.kind === 'external' ? 'mcp' : 'builtin',
    ok: o.ok,
    ms: o.durationMs ?? 0,
    affected: o.meta?.affected ?? null,
    resultChars: o.content.length,
    err: o.ok ? null : o.content.slice(0, 200),
    confirm: o.meta?.confirm ?? null,
  });
}

/** 去重复用：不执行、不发 running，只等首个调用出结果后**重放一张自己的终态卡**（detail 标注复用） */
async function reuseFirst(ctx: StepEmitterCtx, first: Promise<ExecResult>, call: ToolCall): Promise<ExecResult> {
  const r = await first;
  const detail = r.step.detail ? `${r.step.detail}（去重复用）` : '（去重复用）';
  if (r.step.status === 'error') {
    ctx.onStep(call.name, 'error', detail, {
      args: call.arguments,
      toolCallId: call.id,
      durationMs: r.step.durationMs,
      errorText: r.step.errorText,
    });
  } else {
    ctx.onStep(call.name, 'done', detail, {
      args: call.arguments,
      result: r.step.result,
      toolCallId: call.id,
      durationMs: r.step.durationMs,
    });
  }
  // reused 标记：卡片照重放（B-010 配对需要每张终态卡），但统计不再记第二笔
  return { outcome: { ...r.outcome, id: call.id, reused: true }, step: { ...r.step, detail } };
}

/** 真正的单次执行（含分档超时 / 静默重试）。抽出顶层函数是为了不让 runToolCalls 再长一层闭包 */
async function execute(
  call: ToolCall,
  exec: ToolExecFn,
  ctx: StepEmitterCtx,
  opts: ToolExecOptions,
  signal: AbortSignal | undefined,
  noTimeout: string[],
  abortRace: Promise<never> | null,
): Promise<ExecResult> {
  if (signal?.aborted) {
    ctx.onStep(call.name, 'error', '已停止', { toolCallId: call.id, errorText: '已停止' });
    return { outcome: { id: call.id, name: call.name, content: ABORT_HINT, ok: false }, step: { status: 'error', detail: '已停止', errorText: '已停止' } };
  }
  const meta = toolMeta(call.name);
  const timeoutMs = resolveToolTimeoutMs(call.name, opts.timeoutMs);
  // §4.3-5 重试资格：network 且幂等（注册表是唯一事实源，不在此维护名单）
  const maxAttempts = meta?.kind === 'network' && meta.idempotent === true ? 2 : 1;
  /**
   * 执行起点：本次调用**真实开跑**的那一刻（前置中止的分支根本走不到这里）。
   * 重试共享同一 t0：给用户看的是"这次调用一共等了多久"，是墙钟事实。
   */
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;

  for (let attempt = 1; ; attempt++) {
    /**
     * 终态接管：工具实现（chat/tools/）内部会自己发 done/error，这里**拦下缓存、
     * 不直接透出**，等 race 出结果后由本调度器统一重发一次并附上 args/result 载荷——
     * 保证每张过程卡片有且只有一个终态，且点开能看到输入输出（SSE 契约 2026-09-09）。
     * running 原样透传（过程态要实时），但顺手挂上 toolCallId——注入只在这一处（见 StepPayload 头注）。
     * ★ 重试尝试的 running **压下不发**：B-010 后前端每张 running 卡都开新条目，
     *   发了就是用户眼里"同一工具跑了两遍"；静默重试只让调度器知道。
     */
    let terminal: { status: 'done' | 'error'; detail?: string } | undefined;
    const callCtx: ToolContext = {
      onStep: (tool, status, detail) => {
        if (status === 'running') {
          if (attempt === 1) ctx.onStep(tool, 'running', detail, { toolCallId: call.id });
          return;
        }
        terminal = { status, detail };
      },
      // signal 透传进工具内部：联网工具据此真掐断 HTTP 请求（v13 体验升级）
      signal,
      // 会话 id 透传进工具：ask_choice 据此把提问绑到当前会话（方案选择框）
      sessionId: opts.sessionId,
      // 归属透传进工具：tidy_terms 的 auto 分支要调模型，记在发起这一轮的人头上（M2c）
      ownerId: opts.ownerId,
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const racers: Array<Promise<ToolResult>> = [exec(call.name, call.arguments, callCtx)];
      // 长等待工具豁免超时：只留 exec + abortRace。ask_choice 等的是「人」，档位上限
      // 会把等待本身掐死（契约不设超时），故按 noTimeout 名单跳过 timer 那一支。
      if (!noTimeout.includes(call.name)) {
        racers.push(
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ToolTimeoutError(timeoutMs)), timeoutMs);
          }),
        );
      }
      if (abortRace) racers.push(abortRace);
      const r = await Promise.race(racers);
      const durationMs = elapsed();
      // 工具内部已自判 error 却正常返回（如搜索词为空）：如实重发 error，不再补 done
      if (terminal?.status === 'error') {
        ctx.onStep(call.name, 'error', terminal.detail, {
          args: call.arguments,
          toolCallId: call.id,
          durationMs,
          errorText: terminal.detail,
        });
        return {
          outcome: { id: call.id, name: call.name, content: r.content, ok: true, durationMs, meta: r.meta },
          step: { status: 'error', detail: terminal.detail, errorText: terminal.detail, durationMs },
        };
      }
      ctx.onStep(call.name, 'done', terminal?.detail, {
        args: call.arguments,
        result: r.content.slice(0, RESULT_SNIPPET_CHARS),
        toolCallId: call.id,
        durationMs,
      });
      return {
        outcome: { id: call.id, name: call.name, content: r.content, ok: true, durationMs, meta: r.meta },
        step: { status: 'done', detail: terminal?.detail, result: r.content.slice(0, RESULT_SNIPPET_CHARS), durationMs },
      };
    } catch (err) {
      const aborted = signal?.aborted === true;
      const timedOut = err instanceof ToolTimeoutError;
      // 中止不重试（用户已表态）；有资格的异常/超时静默再来一次（terminal 缓存与 timer 都换新一次尝试）
      if (!aborted && attempt < maxAttempts) continue;
      const detail = aborted
        ? '已停止'
        : timedOut
          ? `超时 ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      // 中止/超时同样有真实耗时（等了多久是事实，重试则含两次尝试）；errorText 与 result 互斥——失败原因不伪装成结果摘要
      const durationMs = elapsed();
      ctx.onStep(call.name, 'error', detail, { args: call.arguments, toolCallId: call.id, durationMs, errorText: detail });
      return {
        outcome: {
          id: call.id,
          name: call.name,
          content: aborted ? ABORT_HINT : timedOut ? TIMEOUT_HINT : `工具执行失败：${detail}`,
          ok: false,
          durationMs,
        },
        step: { status: 'error', detail, errorText: detail, durationMs },
      };
    } finally {
      // 必须清：不清的话每个工具都会挂一个 timer 拖到超时点，Node 进程退出被推迟
      if (timer) clearTimeout(timer);
    }
  }
}
