/**
 * api-request — REST 封装的**最低层**（`ApiError` + `request`）。
 *
 * ★ 为什么单独成文件（2026-09-16 学习流批抽出的）：`api.ts` 已 357/400 行，触 gates 的
 *   「.ts ≤400 行」红线。新增「学习流」分组有 20 个端点，放进 `api.ts` 必越线；而放新文件
 *   就会 `api.ts → api-study-flow.ts → api.ts` 形成**循环依赖**（本仓对循环依赖是明令避让的，
 *   见 `QUIZ-WEAK-SPEC` §9 那次「刻意不做 re-export」）。⇒ 把两者都要用的这一层抽出来，
 *   双方各自单向依赖本文件，**环断在这里**。
 *
 * ★ `api.ts` 仍 `export { ApiError }` 转出本类的**类型与运行期值**，既有
 *   `import { api, ApiError } from '../../lib/api'` 三处调用方（PkApp / PkMatch / SettingsView）
 *   零改动。
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /**
     * 服务端响应体原文。**P0-7 起必需**：跑题时裁判给的建议走 `extra` 随错误一起回，
     * 前端要把它显示出来——只留 message 的话，等于让玩家看到一句「跑题了」却不知道该往哪改。
     */
    public body?: unknown,
  ) {
    super(message);
  }
}

/**
 * 单个请求的可选项 = 原生 `RequestInit` + 本层自有的 `timeoutMs`。
 * ★ 不用 `RequestInit.timeout`（那是 Node 私有的、浏览器不认）——跨端一致靠这里的自实现。
 */
export interface RequestOptions extends RequestInit {
  /** 显式超时（毫秒）；**省略 = 不设超时**（与原生 fetch 同行为）。见下方「为什么默认不设」。 */
  timeoutMs?: number;
}

/**
 * 长任务的默认超时（3 分钟）。
 *
 * ★ 这个数从哪来：学习流的**一步 = 一次 HTTP 请求里跑完一整轮 LLM 对话**（含检索/多轮工具），
 *   数十秒是常态、慢模型 + 联网可到分钟级。SPEC §13 第 5 条点名「前端超时未定」是必做项。
 *   给 180s 的口径：比任何合理单步都长，又比「用户以为页面死了」短。
 * ★ 超时**不等于失败**——服务端那一步多半仍在跑（前端断开不会中止后端已开始的执行）。
 *   故超时文案必须如实说明这点并引导用户去看运行轨迹，而不是简单甩一句「请求失败」。
 */
export const LONG_TASK_TIMEOUT_MS = 180_000;

/**
 * 超时/中断的错误形态：`status = 0` 表示**没拿到 HTTP 响应**（压根不是服务端拒绝）。
 * 调用方据此与真实 HTTP 错误（4xx/5xx）分开处理，别把「等太久」显示成「服务端报错」。
 */
export const NO_RESPONSE = 0;

/** 同源经 vite proxy；错误统一抛 `ApiError`，UI 层可见可重试（ADR-5） */
export async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const { timeoutMs, signal, ...rest } = init ?? {};

  /**
   * ★ 为什么自己造 `AbortController` 而不是直接把 `signal` 传下去：
   *   本层要能因**超时**而中止，调用方要能因**用户点取消**而中止——两个来源必须都能触发同一个 fetch，
   *   而 `RequestInit.signal` 只能接一个信号。故用本地 controller 做汇聚点，把外部 signal 的事件转发进来。
   */
  const ctrl = new AbortController();
  const forwardAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let timedOut = false;
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ctrl.abort();
        }, timeoutMs)
      : undefined;

  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...rest,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body);
    }
    return (await res.json()) as T;
  } catch (e) {
    // 超时：如实说明「前端不再等了」与「后端可能仍在跑」是两件事（ADR-5 不静默）
    if (timedOut) {
      throw new ApiError(
        NO_RESPONSE,
        `等待超过 ${Math.round((timeoutMs ?? 0) / 1000)} 秒，已停止等待。这一步在服务端可能仍在执行，可稍后在「运行轨迹」里查看结果。`,
        null,
      );
    }
    // 用户主动取消：原样抛出（不做包装——「我取消的」和「出错」在 UI 上是两种呈现，调用方自己认 AbortError）
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
