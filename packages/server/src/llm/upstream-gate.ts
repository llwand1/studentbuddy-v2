/**
 * llm/upstream-gate — 上游并发闸门（2026-09-17）。
 *
 * 【为什么需要】一次真实事故（诊断全文见 `_probe/DIAGNOSIS.md`）：两路会话同时对话时
 * 双双卡在「回复中」。排查已排除编排锁 / SSE 总线 / 适配器实例状态，根因是**上游挂起后
 * 没有兜底**（见 `upstream-timeout.ts`）。但事故还有第二层：**配额踩踏**——每轮对话在
 * `done` 之后固定追加两次 LLM 调用（`extractTerms` → `compactIfNeeded`），它们与主链
 * 共享同一个上游配额；实测可见「A 完成后其后台任务立刻抢走刚空出的配额」，
 * 让被挂起的会话更难恢复。
 *
 * 【做法】给每个上游端点（`baseUrl`）一个信号量，主链优先、后台让路：
 * - 容量 `UPSTREAM_MAX_CONCURRENT = 2` —— 老板 2026-09-17 拍板：「限制并发，但是应该
 *   两个对话同时运行还是可以的」。2 是**下限**：容量给 1 会把两路对话焊成串行，
 *   一路慢就拖死另一路（那正是要修的现象）；给 3 以上又失去限流意义（上游本来就
 *   是在并发配额不足时才挂起的）。
 * - 排队中的 `background` 请求不得越过排队中的 `main` 请求 —— 主链延迟是用户可感知的
 *   转圈，后台任务只是为下一轮备料，晚几秒无感。
 *
 * ⚠️ 本闸门**必须与 `upstream-timeout.ts` 同时生效**：闸门把「无限并发」变成「排队」，
 *    而排队的安全性完全依赖「持有者一定会释放」。若上游挂起时持有者永不释放，容量会被
 *    永久占满，反而比不限并发更糟（从「各自卡」变成「互相拖死」）——这正是 L1（超时兜底）
 *    与 L2（并发闸门）必须同批落地的原因。
 */
import type { UpstreamPurpose } from './types.js';

/** 每个上游端点同时允许的在飞请求数。2 = 两路对话可并行，且不放开限流意图。 */
export const UPSTREAM_MAX_CONCURRENT = 2;

/** 排队期间被停止时抛出的错误文案（与 flow 的「已停止」口径一致） */
const QUEUE_ABORT_MESSAGE = '已停止';

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** 单个上游端点的信号量（主链优先、后台让路） */
class Gate {
  private active = 0;
  private readonly main: Waiter[] = [];
  private readonly background: Waiter[] = [];

  constructor(private readonly capacity: number) {}

  acquire(purpose: UpstreamPurpose, signal?: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      if (this.canAdmit(purpose)) {
        this.active += 1;
        resolve(this.makeRelease());
        return;
      }
      // 已在别处被停止：不排队直接拒——否则会占着队列位等一个永远不会来的放行
      if (signal?.aborted) {
        reject(new Error(QUEUE_ABORT_MESSAGE));
        return;
      }
      const waiter: Waiter = { resolve: () => resolve(this.makeRelease()), reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          Gate.dropFrom(this.main, this.background, waiter);
          reject(new Error(QUEUE_ABORT_MESSAGE));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      (purpose === 'main' ? this.main : this.background).push(waiter);
    });
  }

  stats(): { inFlight: number; pendingMain: number; pendingBackground: number } {
    return { inFlight: this.active, pendingMain: this.main.length, pendingBackground: this.background.length };
  }

  /** 放行条件：有空位，且（是主链 或 主链没人在排队） */
  private canAdmit(purpose: UpstreamPurpose): boolean {
    if (this.active >= this.capacity) return false;
    return purpose === 'main' || this.main.length === 0;
  }

  /** release 幂等：重复调用不会把容量还两次（下游 finally 与异常路径都可能调到） */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  /** 每次释放后尽最大可能放行（主链队列优先于后台队列） */
  private drain(): void {
    while (this.active < this.capacity) {
      const waiter = this.main.shift() ?? this.background.shift();
      if (!waiter) return;
      this.active += 1;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.resolve();
    }
  }

  private static dropFrom(main: Waiter[], background: Waiter[], waiter: Waiter): void {
    for (const queue of [main, background]) {
      const i = queue.indexOf(waiter);
      if (i >= 0) {
        queue.splice(i, 1);
        return;
      }
    }
  }
}

/** 按上游端点分桶：配同一个 baseUrl 的两条 provider 记录 = 同一个上游 = 共享闸门 */
const gates = new Map<string, Gate>();

function gateFor(baseUrl: string): Gate {
  const key = baseUrl || 'unknown-upstream';
  let gate = gates.get(key);
  if (!gate) {
    gate = new Gate(UPSTREAM_MAX_CONCURRENT);
    gates.set(key, gate);
  }
  return gate;
}

/**
 * 取得一个上游配额槽。返回 release 函数（幂等），**必须在 finally 里调用**。
 * @param baseUrl 上游端点（闸门分桶键）
 * @param purpose 主链（用户在等）还是后台（为下一轮备料）
 * @param signal  调用方中止信号；排队期间被停止会 reject 而不是继续等
 */
export function acquireUpstream(
  baseUrl: string,
  purpose: UpstreamPurpose = 'main',
  signal?: AbortSignal,
): Promise<() => void> {
  return gateFor(baseUrl).acquire(purpose, signal);
}

/** 诊断/测试用：某个上游当前的占用快照 */
export function upstreamStats(baseUrl: string): { inFlight: number; pendingMain: number; pendingBackground: number } {
  return gateFor(baseUrl).stats();
}

/** 测试用：清空全部闸门（用例之间不串味；生产路径不调用） */
export function resetUpstreamGates(): void {
  gates.clear();
}
