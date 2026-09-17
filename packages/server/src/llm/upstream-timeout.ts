/**
 * llm/upstream-timeout — 上游等待兜底（2026-09-17）。
 *
 * 【根因】原实现在两个适配器里都写成**二选一**分支：
 *   if (req.signal) { 桥接外部信号 } else { setTimeout(abort, 120_000) }
 * 而生产路径（`routes.ts` 的 `/chat/send`、`/regenerate`、`/resend`）**总是**传 signal
 * （来自 aborters 里那个 `AbortController`，只在用户点「停止」时才 abort）
 * ⇒ 那句 120s 兜底**从未生效过**。上游不回数据、也不断连时，这一轮永久停在生成中：
 *   fetch 永久 pending → `runTurn` 不 settle → aborters 不摘除（侧栏「回复中」永不消失）
 *   → 该会话 SSE 永无 done 帧 → 前端 `busy` 永久 true（输入框永久禁用）。
 * 这正是「两个会话同时运行时双双卡住」的完整链条（诊断见 `_probe/DIAGNOSIS.md`）。
 *
 * 【做法】把「二选一」改成「并存」，并区分两种等待形态：
 * - 流式（`chat`）：**空闲超时**——每收到一段数据就重置计时。上游有数据在流就不该被掐，
 *   长回答因此不受影响，只有「真挂起」才会被兜住。首字节之前同样计时（原实现此时完全裸奔）。
 * - 一次性（`chatOnce`）：没有任何中间帧可等，只能用**总时长超时**。
 *
 * 超时后抛**可读错误**而非裸 `AbortError`：走 `flow.ts` 既有 catch 分支 → 发 chat-error
 * + done → busy 解除、aborters 摘除。用户看到「上游无响应，已中止」而不是永久转圈。
 * 判据：`timedOut()` 为真 ⇒ 是超时；为假而 `external.aborted` 为真 ⇒ 是用户主动停止。
 */

/** 流式：超过这么久没有任何数据帧即判定上游挂起 */
export const UPSTREAM_IDLE_MS = 120_000;
/** 一次性：无中间帧可等，用总时长（中转池按非流式聚合转发，通常比流式慢） */
export const UPSTREAM_TOTAL_MS = 180_000;

export interface UpstreamGuard {
  /** 收到任何数据（含终帧）即调用，刷新空闲计时 */
  touch(): void;
  /** 卸载计时器与外部信号监听（必须在 finally 调用） */
  dispose(): void;
  /** 是否因超时被中止（用于与「用户主动停止」区分） */
  timedOut(): boolean;
  /** 超时原因的可读文案（未超时为 null） */
  timeoutMessage(): string | null;
}

export function createUpstreamGuard(opts: {
  controller: AbortController;
  external?: AbortSignal;
  /** 空闲超时（流式）。与 totalMs 互斥使用 */
  idleMs?: number;
  /** 总时长超时（一次性） */
  totalMs?: number;
}): UpstreamGuard {
  const { controller, external } = opts;
  const idle = opts.idleMs && opts.idleMs > 0 ? opts.idleMs : undefined;
  const total = opts.totalMs && opts.totalMs > 0 ? opts.totalMs : undefined;

  let timedOut = false;
  let disposed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const fire = () => {
    timedOut = true;
    controller.abort();
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(fire, idle);
  };

  if (idle) armIdle();
  if (total) totalTimer = setTimeout(fire, total);

  return {
    touch: () => {
      // dispose 之后不得再建计时器（否则会往一个已结束的轮次里塞 abort）
      if (disposed || !idle) return;
      armIdle();
    },
    dispose: () => {
      disposed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (external) external.removeEventListener('abort', onExternalAbort);
    },
    timedOut: () => timedOut,
    timeoutMessage: () => {
      if (!timedOut) return null;
      const seconds = Math.round((idle ?? total ?? 0) / 1000);
      return `上游 ${seconds} 秒无响应，已中止本轮（服务商可能过载或限流，可稍后重试）`;
    },
  };
}

/** 把「因超时被中止」转成可读错误；非超时的原始错误原样透传（HTTP 4xx/5xx 等要保真） */
export function asUpstreamError(err: unknown, guard: UpstreamGuard): unknown {
  if (guard.timedOut()) return new Error(guard.timeoutMessage() ?? '上游无响应，已中止本轮');
  return err;
}
