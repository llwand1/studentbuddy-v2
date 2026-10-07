/**
 * ai/gateway — **所有模型调用的唯一出入口**（AI 网关）。
 *
 * 改前：14 个模块各自 `routeRole()` → `for await (adapter.chat())` → 自己拼文本，
 * 超时各写各的（多数没写：上游挂住就一直挂着）、失败多数被 `catch {}` 吞掉、
 * 耗时/token/失败率无处可查、JSON 输出坏了就直接丢（只有出题有一套专用修复）。
 *
 * 本网关统一做五件事：
 *   ① **路由**：按用途（`ai/purposes.ts`）取缺省角色；调用方有特殊回落链时可自带 `target`；
 *   ② **超时与取消**：按用途给默认超时，和调用方的 `signal` 合并成一个 AbortSignal；
 *   ③ **结果分类**：`no-model`／`timeout`／`aborted`／`upstream`／`parse` 五种失败，
 *      让调用点能对用户说真话（"去设置页绑模型"≠"模型超时了，可重试"）；
 *   ④ **结构化输出**：`aiJson` 拿调用方的解析函数校验，解析失败时把原输出和错因回喂给模型**修复一次**；
 *   ⑤ **追踪**：每一次尝试发一个 `llm_call` 总线事件（订阅方 `ai/call-log.ts` 落库），
 *      网关本身**不碰数据库**——被 mock 掉 router 的单测不会意外开出真库文件（同 `tool_called` 分工）。
 *
 * ★ 流式对话（`chat/flow.ts`）仍自己逐块推 SSE，只借 `reportLlmCall` 记一行账——
 *   把流式也塞进网关会把"逐字上屏"与"工具循环"两套逻辑搅在一起，得不偿失。
 */
import { randomUUID } from 'node:crypto';
import type { ModelRole } from '@sb/shared';
import { publishEvent } from '../events/bus.js';
import { routeRole, type RoutedTarget } from '../llm/router.js';
import type { ChatMessage, ChatRequest, TokenChunk, ToolCall, UpstreamPurpose } from '../llm/types.js';
import { AI_PURPOSES, type AiPurpose } from './purposes.js';

export type AiFailure = 'no-model' | 'timeout' | 'aborted' | 'upstream' | 'parse';
export type AiCallStatus = 'ok' | AiFailure;

export interface AiCallOptions {
  purpose: AiPurpose;
  ownerId: string | null;
  messages: ChatMessage[];
  /** 覆盖登记表里的缺省角色 */
  role?: ModelRole;
  /** 调用方已按自己的回落链选好目标（coach/npc 先找专用角色再回落 explain）；`null` ⇒ 按没配模型处理 */
  target?: (RoutedTarget & { model: string }) | null;
  temperature?: number;
  maxTokens?: number;
  upstream?: UpstreamPurpose;
  timeoutMs?: number;
  signal?: AbortSignal;
  streamMode?: ChatRequest['streamMode'];
  tools?: ChatRequest['tools'];
  toolChoice?: ChatRequest['toolChoice'];
  /** 每个流式块的回调（想边收边处理的调用方用；不传也能拿到完整文本） */
  onChunk?: (chunk: TokenChunk) => void;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

export type AiTextResult =
  | {
      ok: true;
      text: string;
      finishReason?: string;
      usage?: AiUsage;
      toolCalls?: ToolCall[];
      model: string;
      latencyMs: number;
    }
  | { ok: false; reason: AiFailure; error: string; text: string; model: string; latencyMs: number };

/** `llm_call` 总线事件的载荷（订阅方据此落库） */
export interface LlmCallRecord {
  id: string;
  ownerId: string | null;
  purpose: string;
  promptVersion: number;
  role: string;
  model: string;
  platform: boolean;
  status: AiCallStatus;
  attempt: number;
  latencyMs: number;
  usage?: AiUsage;
  finishReason?: string;
  error?: string;
}

/** 记一行调用账（网关内部用；流式对话等自己驱动适配器的调用点也用它补记） */
export function reportLlmCall(rec: Omit<LlmCallRecord, 'id' | 'promptVersion'> & { promptVersion?: number }): void {
  const info = AI_PURPOSES[rec.purpose as AiPurpose];
  publishEvent({
    type: 'llm_call',
    record: { ...rec, id: randomUUID(), promptVersion: rec.promptVersion ?? info?.version ?? 1 },
  });
}

function resolveTarget(opts: AiCallOptions): (RoutedTarget & { model: string }) | null {
  if (opts.target !== undefined) return opts.target && opts.target.model ? opts.target : null;
  const t = routeRole(opts.role ?? AI_PURPOSES[opts.purpose].role, undefined, opts.ownerId);
  return t && t.model ? t : null;
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

interface Attempt {
  res: AiTextResult;
  /** 落这一次的账。成功的调用可以改记成 `parse`（结构化解析没过）——一次尝试只记一行 */
  log: (override?: { status: AiCallStatus; error: string }) => void;
}

async function attempt(opts: AiCallOptions, messages: ChatMessage[], n: number): Promise<Attempt> {
  const info = AI_PURPOSES[opts.purpose];
  const role = opts.role ?? info.role;
  const started = Date.now();
  const target = resolveTarget(opts);
  const base = { ownerId: opts.ownerId, purpose: opts.purpose, role, attempt: n };
  if (!target) {
    return {
      res: { ok: false, reason: 'no-model', error: '该角色还没有可用的模型', text: '', model: '', latencyMs: 0 },
      log: () => reportLlmCall({ ...base, model: '', platform: false, status: 'no-model', latencyMs: 0 }),
    };
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? info.timeoutMs);
  const onOuterAbort = () => timeout.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (opts.signal?.aborted) onOuterAbort();
  let text = '';
  let finishReason: string | undefined;
  let usage: AiUsage | undefined;
  let toolCalls: ToolCall[] | undefined;
  const logAs = (status: AiCallStatus, latencyMs: number, error?: string) => (override?: { status: AiCallStatus; error: string }) =>
    reportLlmCall({
      ...base, model: target.model, platform: target.quota?.platform ?? false, latencyMs, usage, finishReason,
      status: override?.status ?? status, error: override?.error ?? error,
    });
  try {
    if (timeout.signal.aborted) throw new Error('aborted');
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      purpose: opts.upstream ?? info.upstream,
      signal: timeout.signal,
      streamMode: opts.streamMode,
      tools: opts.tools,
      toolChoice: opts.toolChoice,
    })) {
      if (timeout.signal.aborted) break;
      opts.onChunk?.(chunk);
      text += chunk.content;
      if (chunk.usage) usage = { promptTokens: chunk.usage.promptTokens, completionTokens: chunk.usage.completionTokens };
      if (chunk.toolCalls?.length) toolCalls = chunk.toolCalls;
      if (chunk.done) {
        finishReason = chunk.finishReason;
        break;
      }
    }
    if (timeout.signal.aborted) throw new Error('aborted');
    const latencyMs = Date.now() - started;
    return { res: { ok: true, text, finishReason, usage, toolCalls, model: target.model, latencyMs }, log: logAs('ok', latencyMs) };
  } catch (e) {
    const reason: AiFailure = opts.signal?.aborted ? 'aborted' : timeout.signal.aborted ? 'timeout' : 'upstream';
    const error = reason === 'timeout' ? `模型 ${Math.round((opts.timeoutMs ?? info.timeoutMs) / 1000)} 秒内没有答完` : reason === 'aborted' ? '已取消' : errText(e);
    const latencyMs = Date.now() - started;
    return { res: { ok: false, reason, error, text, model: target.model, latencyMs }, log: logAs(reason, latencyMs, error) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** 一次文本调用：拿到完整文本，或一个分好类的失败 */
export async function aiText(opts: AiCallOptions): Promise<AiTextResult> {
  const a = await attempt(opts, opts.messages, 1);
  a.log();
  return a.res;
}

export interface AiJsonOptions<T> extends AiCallOptions {
  /** 解析 + 校验：返回 null 表示"不成形"。★ 由调用方提供——各协议（[TERMS]、题组 JSON…）形状各不相同 */
  parse: (text: string) => T | null;
  /** 解析失败后最多修复几次（缺省 1）。每次修复都是一次真实调用，也各记一行账 */
  repairs?: number;
  /** 修复时告诉模型输出应该长什么样（缺省一句通用话） */
  repairHint?: string;
  /** 首次调用与所有修复共用的总预算；排队也计入。未传时沿用单次超时。 */
  totalTimeoutMs?: number;
  /** 修复输出上限；仅显式提高上限时才允许修复 length 截断，最多仍为 repairs 次。 */
  repairMaxTokens?: number;
}

export type AiJsonResult<T> =
  | (Extract<AiTextResult, { ok: true }> & { value: T; repaired: boolean })
  | Extract<AiTextResult, { ok: false }>;

/**
 * 结构化调用：解析失败时把"你上次的输出"和"应该的形状"回喂给模型修复。
 * ★ 截断只在调用方显式提高输出上限时修复，且受总预算约束；同一上限下不盲重试。
 */
export async function aiJson<T>(opts: AiJsonOptions<T>): Promise<AiJsonResult<T>> {
  const started = Date.now();
  const deadline = opts.totalTimeoutMs === undefined ? Infinity : started + opts.totalTimeoutMs;
  let messages = opts.messages;
  const repairs = opts.repairs ?? 1;
  for (let n = 1; ; n += 1) {
    const maxTokens = n > 1 ? opts.repairMaxTokens ?? opts.maxTokens : opts.maxTokens;
    const a = await attempt({
      ...opts,
      timeoutMs: Math.min(opts.timeoutMs ?? AI_PURPOSES[opts.purpose].timeoutMs, Math.max(0, deadline - Date.now())),
      maxTokens,
    }, messages, n);
    const r = a.res;
    if (!r.ok) {
      const error = r.reason === 'timeout' && opts.totalTimeoutMs !== undefined
        ? `模型在 ${Math.round(opts.totalTimeoutMs / 1000)} 秒总预算内没有完成回答或修复` : r.error;
      a.log({ status: r.reason, error });
      return { ...r, error, latencyMs: Date.now() - started };
    }
    let value: T | null = null;
    try {
      value = opts.parse(r.text);
    } catch {
      value = null; // 解析函数自己抛了也按"不成形"处理，不把异常漏给调用方
    }
    const parseError = r.finishReason === 'length' ? '输出达到 token 上限，结构化结果未完成' : '输出不符合约定格式';
    a.log(value === null ? { status: 'parse', error: parseError } : undefined);
    if (value !== null) return { ...r, value, repaired: n > 1, latencyMs: Date.now() - started };
    const canRepairLength = (opts.repairMaxTokens ?? 0) > (maxTokens ?? Infinity);
    if (n > repairs || (r.finishReason === 'length' && !canRepairLength) || Date.now() >= deadline) {
      return { ok: false, reason: 'parse', error: parseError, text: r.text, model: r.model, latencyMs: Date.now() - started };
    }
    messages = [
      ...opts.messages,
      { role: 'assistant', content: r.text.slice(0, 20_000) },
      {
        role: 'user',
        content: `你上面的输出无法按约定格式解析。${opts.repairHint ?? '请严格按最开始要求的格式重新输出完整结果，不要解释，不要加多余文字。'}`,
      },
    ];
  }
}

/**
 * 给**自己驱动适配器**的调用点（流式对话 `chat/flow.ts`、收尾追问 `chat/grill.ts`）用的计量器：
 * 不接管调用，只把耗时、token、结局记成一行 `llm_call`。
 * 用法：调用前 `const m = startLlmMeter(...)`，每块 `m.see(chunk)`，结束 `m.ok()`，出错 `m.fail(err, aborted)`。
 * ★ 幂等：同一个计量器只记第一次结局（ok 之后外层 catch 再 fail 不会多记一行）。
 */
export function startLlmMeter(
  purpose: AiPurpose,
  ownerId: string | null,
  target: { model: string; quota?: { platform: boolean } },
): { see: (chunk: TokenChunk) => void; ok: () => void; fail: (err: unknown, aborted?: boolean) => void } {
  const started = Date.now();
  let usage: AiUsage | undefined;
  let finishReason: string | undefined;
  let closed = false;
  const close = (status: AiCallStatus, error?: string) => {
    if (closed) return;
    closed = true;
    reportLlmCall({
      ownerId, purpose, role: AI_PURPOSES[purpose].role, attempt: 1, model: target.model,
      platform: target.quota?.platform ?? false, status, latencyMs: Date.now() - started, usage, finishReason, error,
    });
  };
  return {
    see: (chunk) => {
      if (chunk.usage) usage = { promptTokens: chunk.usage.promptTokens, completionTokens: chunk.usage.completionTokens };
      if (chunk.done) finishReason = chunk.finishReason;
    },
    ok: () => close('ok'),
    fail: (err, aborted = false) => close(aborted ? 'aborted' : 'upstream', aborted ? '已取消' : errText(err)),
  };
}
