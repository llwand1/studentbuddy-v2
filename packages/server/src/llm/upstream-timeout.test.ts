/**
 * llm/upstream-timeout 回归：上游等待兜底（本次事故的根因修复）。
 *
 * 原始缺陷（诊断全文 `_probe/DIAGNOSIS.md`）：
 *   if (req.signal) { 桥接外部信号 } else { setTimeout(abort, 120_000) }
 * 生产路径（/chat/send、/regenerate、/resend）**总是**传 signal ⇒ 那句 120s 兜底
 * **从未生效**。上游不回数据也不断连时，这一轮永久停在生成中，用户看到的是
 * 「两个会话双双卡在回复中」——所以本文件的核心是「**有 signal 时也必须兜底**」。
 *
 * 全部用假时钟测定，不打网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asUpstreamError,
  createUpstreamGuard,
  UPSTREAM_IDLE_MS,
  UPSTREAM_TOTAL_MS,
} from './upstream-timeout.js';

describe('等待兜底阈值', () => {
  it('口径钉死：流式空闲 120s / 一次性总时长 180s', () => {
    expect(UPSTREAM_IDLE_MS).toBe(120_000);
    expect(UPSTREAM_TOTAL_MS).toBe(180_000);
  });
});

describe('流式：空闲超时', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('★ 传了外部 signal 也照样兜底（这正是旧实现的失效条件）', () => {
    const controller = new AbortController();
    const external = new AbortController(); // 用户没点停止，一直不 abort
    const guard = createUpstreamGuard({ controller, external: external.signal, idleMs: 1000 });

    vi.advanceTimersByTime(999);
    expect(controller.signal.aborted).toBe(false); // 未到阈值不误杀
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
    expect(guard.timedOut()).toBe(true);
    guard.dispose();
  });

  it('不传外部 signal 时同样兜底（两条路并存，不再是二选一）', () => {
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, idleMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(controller.signal.aborted).toBe(true);
    expect(guard.timedOut()).toBe(true);
    guard.dispose();
  });

  it('touch 重置计时：上游有数据在流就不该被掐（长回答不受影响）', () => {
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, idleMs: 1000 });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      guard.touch();
    }
    expect(controller.signal.aborted).toBe(false); // 累计 4.5s，但每段都在阈值内
    vi.advanceTimersByTime(1001);
    expect(controller.signal.aborted).toBe(true);
    guard.dispose();
  });
});

describe('一次性回答：总时长超时', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('无中间帧可等，touch 不重置计时（该模式没有空闲概念）', () => {
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, totalMs: 1000 });
    vi.advanceTimersByTime(900);
    guard.touch();
    vi.advanceTimersByTime(100);
    expect(controller.signal.aborted).toBe(true);
    expect(guard.timedOut()).toBe(true);
    guard.dispose();
  });
});

describe('与「用户主动停止」的区分', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('外部信号先中止：abort 生效但**不算超时**（否则会把「已停止」谎报成上游故障）', () => {
    const controller = new AbortController();
    const external = new AbortController();
    const guard = createUpstreamGuard({ controller, external: external.signal, idleMs: 60_000 });

    external.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(guard.timedOut()).toBe(false);
    expect(guard.timeoutMessage()).toBeNull();
    guard.dispose();
  });

  it('外部信号已中止：立即 abort，不必等计时器', () => {
    const controller = new AbortController();
    const external = new AbortController();
    external.abort();
    const guard = createUpstreamGuard({ controller, external: external.signal, idleMs: 60_000 });
    expect(controller.signal.aborted).toBe(true);
    guard.dispose();
  });

  it('dispose 后不再触发（已结束的轮次不该被塞一个迟到的 abort）', () => {
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, idleMs: 1000 });
    guard.dispose();
    vi.advanceTimersByTime(60_000);
    expect(controller.signal.aborted).toBe(false);
    // dispose 后 touch 也不得复活计时器
    guard.touch();
    vi.advanceTimersByTime(60_000);
    expect(controller.signal.aborted).toBe(false);
  });

  it('dispose 摘掉外部监听：之后外部 abort 不再打到已结束的 controller', () => {
    const controller = new AbortController();
    const external = new AbortController();
    const guard = createUpstreamGuard({ controller, external: external.signal, idleMs: 60_000 });
    guard.dispose();
    external.abort();
    expect(controller.signal.aborted).toBe(false);
  });
});

describe('错误呈现', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('超时文案可读且带秒数（用户看到的不是裸 AbortError）', () => {
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, idleMs: 120_000 });
    vi.advanceTimersByTime(120_000);
    const msg = guard.timeoutMessage();
    expect(msg).toContain('120 秒');
    expect(msg).toContain('无响应');
    expect(msg).toContain('已中止本轮');
    guard.dispose();
  });

  it('asUpstreamError：超时转成可读错误', () => {
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, idleMs: 1000 });
    vi.advanceTimersByTime(1000);
    const mapped = asUpstreamError(new Error('This operation was aborted'), guard);
    expect((mapped as Error).message).toContain('无响应');
    expect((mapped as Error).message).not.toContain('operation was aborted');
    guard.dispose();
  });

  it('asUpstreamError：非超时的原始错误原样透传（HTTP 报文要保真）', () => {
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, idleMs: 60_000 });
    const raw = new Error('OpenAI API error 429: rate limited');
    expect(asUpstreamError(raw, guard)).toBe(raw);
    guard.dispose();
  });
});
