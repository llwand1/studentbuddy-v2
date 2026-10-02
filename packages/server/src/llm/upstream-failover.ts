/**
 * llm/upstream-failover — 平台通道的**失败换路**策略（2026-10-02，契约 `docs/TENANCY-SPEC.md` §8.1.3.5）。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────────────
 * 平台通道可配**多路**（`SB_PLATFORM_API_KEY`／`SB_PLATFORM_BASE_URL` 逗号分隔、按位配对）。
 * 线上曾配 3 路（两把免费 key + 一把付费 key），实测：两把免费 key **约 12 发就打满限速**
 * （60 发里 48–49 个 429），付费 key 60/60 零 429。旧实现是「等概率随机挑一路、失败不换路」
 * ⇒ 约 2/3 的请求踩在必限速的免费路上，用户看到 `429 … 免费用户的 API 速率限制`。
 * 本模块把口径改成「**按 env 顺序优先**（`platform-channel.ts#platformRoutes()`，第一路＝主力）
 * + **失败自动换下一路**」。
 *
 * ── 只在平台行生效 ──────────────────────────────────────────────────────────
 * 换路仅当 `req.quota?.platform === true`（平台付钱，多路才有意义）。**BYOK 单凭据、不换路**——
 * 用户自己那把 key 换到哪都是同一把，换路只会把一次失败放大成多次无谓请求。
 *
 * ── 三条硬约束（写进代码，不只是注释）──────────────────────────────────────
 *   ① **绝不在已向客户端吐字节之后换路**：流式一旦产出过 chunk，后续任何错误都**原样抛**
 *      （`runFailover` 里的 `yielded` 标志）。否则用户会看到「前半段 + 重放的前半段」的重复内容。
 *   ② **用户取消（`signal.aborted`）⇒ 立即停，不换路**（`decideFailover` 先看 `aborted`）。
 *   ③ **候选只有一路 ⇒ 行为与从前逐字相同**（循环跑一次即返回/抛出）。
 *
 * ── 已知取舍（如实登记）：每次尝试都会各计一笔闸门用量 ───────────────────────
 * 每换一路都要重新 `acquireUpstream`（按 `baseUrl` 分桶），也就各计一笔「每用户次数配额 +
 * 全站每日上限」。为什么不退还：`acquireUpstream` 的计量点在「两层并发槽都拿到手」那一刻，
 * 要退还就得动闸门 API；而线上每用户上限已是 `off`（对本部署无实际影响），全站每日闸本就是
 * **成本**闸——按 attempts 计是 **fail-closed** 的一侧（宁可多算成本，也不漏算）。
 *
 * ★ 本模块以**纯函数为主**（`shouldFailover` / `decideFailover` / `runFailover` 都不碰网络与库），
 *   便于单测与复用。
 */
import type { ChatRequest } from './types.js';
import { platformRoutes, type PlatformRoute } from './platform-channel.js';

/**
 * 上游 HTTP 错误（**带状态码**）。
 * ★ 存在的唯一理由：换路要按状态码判（429/408/401/403/5xx 换、400/404/422 不换），
 *   而适配器原先抛的是裸 `Error`（状态码只混在文案里）⇒ 判不出来。故把状态码**带进错误对象**，
 *   这也正是「换路可被单测」的前提。★ 文案保持与从前逐字一致（既有用例按 `502` 之类断言）。
 */
export class UpstreamHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamHttpError';
    this.status = status;
  }
}

/**
 * 是否值得换下一路（纯函数）。
 * 参数形状＝适配器实际能拿到的信息：`status`（HTTP 状态码）/ `network`（网络类失败，含超时）。
 *
 * **换**：429（限速——本模块的主要动机）、408（超时）、401/403（这条 key/入口不可用，换一条也许行）、
 *       5xx（上游故障）、网络错误（fetch 抛、超时）。
 * **不换**：400/404/422（请求形状 / 模型名的问题，换路也是白换——每条路都会同样拒）、
 *          未列出的其它状态码（保守：只在明确可换时换）。
 * ★ **用户取消不在此判定**：它由 `decideFailover` 更早一层挡掉（取消与状态码无关）。
 */
export function shouldFailover(e: { status?: number; network?: boolean }): boolean {
  if (e.network) return true;
  const s = e.status;
  if (s === undefined) return false;
  if (s === 408 || s === 429) return true;
  if (s === 401 || s === 403) return true;
  if (s >= 500 && s <= 599) return true;
  return false;
}

/** `AbortError`（用户取消 / 控制器 abort）——DOMException 或 name 被设成 AbortError 的 Error 都认。 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: unknown }).name === 'AbortError';
}

/**
 * 结合「这次尝试的上下文」判定是否换路（纯函数）。
 * @param err      该次尝试抛出的**原始**错误（在 `asUpstreamError` 之前）
 * @param ctx.timedOut 是否因**超时**被中止（`guard.timedOut()`）——超时＝网络类，换
 * @param ctx.aborted  用户是否已取消（`req.signal?.aborted`）——**为真时永远不换**（硬约束 ②）
 */
export function decideFailover(err: unknown, ctx: { timedOut: boolean; aborted: boolean }): boolean {
  if (ctx.aborted) return false; // ★ 硬约束 ②：用户取消立即停，绝不换路（哪怕同时超时）
  if (err instanceof UpstreamHttpError) return shouldFailover({ status: err.status });
  if (ctx.timedOut) return true; // 超时＝网络类
  if (isAbortError(err)) return false; // 非用户取消的 abort（罕见）保守不换
  // 其余（fetch 抛出的网络错等）按网络错误换路；★ 流式已吐字节时由 `runFailover` 的 `yielded` 拦下
  return shouldFailover({ network: true });
}

// ── 换路标记：让「是否可换」随错误一起穿过 async generator 的边界 ──────────────
// 适配器的「一次尝试」是 async generator，它内部 catch 后要把「可换路」这一判断交给外层循环；
// 用不可枚举属性挂在错误对象上（不动 message、不改 instanceof），原对象不可扩展时退化成包装错误。
const FAILOVER_KEY = '__sbFailover';

/** 给错误打上「是否可换路」标记，返回（可能被包装的）Error。 */
export function markFailover(err: unknown, canFailover: boolean): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    Object.defineProperty(e, FAILOVER_KEY, { value: canFailover, configurable: true });
    return e;
  } catch {
    return Object.defineProperty(new Error(e.message), FAILOVER_KEY, { value: canFailover, configurable: true });
  }
}

/** 读「是否可换路」标记（未标记 ⇒ false，即不换）。 */
export function markedFailover(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as Record<string, unknown>)[FAILOVER_KEY] === true;
}

/**
 * 平台行的候选线路；BYOK / 未带配额 ⇒ 返回空数组（调用方据此退化成"单路，行为与从前相同"）。
 * ★ 只认 `platform === true`：BYOK 单凭据不换路（见文件头）。
 */
export function failoverRoutes(req: ChatRequest): ReadonlyArray<PlatformRoute> {
  return req.quota?.platform === true ? platformRoutes() : [];
}

/**
 * 换路执行器：按顺序逐路尝试，把「一次尝试」产出的 chunk 原样转出。
 *
 * ★ 换下一路的**唯一**条件是「这次尝试**尚未产出任何 chunk**」且其错误被 `markFailover(true)` 标记
 *   （标记由适配器按 `decideFailover` 打好）。**产出过 chunk 即不再换**（硬约束 ①）。
 * ★ `acquire` 由调用方注入（`(route) => acquireUpstream(route.baseUrl, purpose, signal, quota)`）——
 *   每次换路都**重新 acquire**（闸门按 `baseUrl` 分桶，换路本就该走新桶），并在本次尝试结束时 `release`。
 * ★ `acquire` 自身抛错（闸门忙 / 全站额度用完）**不在此循环里捕获**：那不是"某一路坏了"，换路无意义。
 */
export async function* runFailover<T>(
  routes: ReadonlyArray<PlatformRoute>,
  opts: {
    acquire: (route: PlatformRoute) => Promise<() => void>;
    attempt: (route: PlatformRoute) => AsyncIterable<T>;
  },
): AsyncIterable<T> {
  let lastErr: unknown;
  for (const route of routes) {
    const release = await opts.acquire(route);
    let yielded = false;
    try {
      for await (const chunk of opts.attempt(route)) {
        yielded = true;
        yield chunk;
      }
      return; // 这一路跑完 ⇒ 成功
    } catch (err) {
      lastErr = err;
      // ★ 硬约束 ①：吐过字节就不换（`yielded`）；未吐字节且标记可换才进下一路。
      if (!yielded && markedFailover(err)) continue;
      throw err;
    } finally {
      release();
    }
  }
  throw lastErr ?? new Error('平台通道没有可用线路');
}