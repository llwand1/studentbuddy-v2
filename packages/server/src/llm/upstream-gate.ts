/**
 * llm/upstream-gate — 上游并发闸门（2026-09-17 建；2026-09-18 M2c 加**两层**）。
 *
 * 【L2 技术闸门：为什么需要】一次真实事故（诊断全文见 `_probe/DIAGNOSIS.md`）：两路会话同时
 * 对话时双双卡在「回复中」。排查已排除编排锁 / SSE 总线 / 适配器实例状态，根因是**上游挂起后
 * 没有兜底**（见 `upstream-timeout.ts`）。但事故还有第二层：**配额踩踏**——每轮对话在
 * `done` 之后固定追加两次 LLM 调用（`extractTerms` → `compactIfNeeded`），它们与主链
 * 共享同一个上游配额；实测可见「A 完成后其后台任务立刻抢走刚空出的配额」，
 * 让被挂起的会话更难恢复。
 *
 * 【做法】给每个上游端点（`baseUrl`）一个信号量，主链优先、后台让路：
 * - 排队中的 `background` 请求不得越过排队中的 `main` 请求 —— 主链延迟是用户可感知的
 *   转圈，后台任务只是为下一轮备料，晚几秒无感。
 *
 * ⚠️ 本闸门**必须与 `upstream-timeout.ts` 同时生效**：闸门把「无限并发」变成「排队」，
 *    而排队的安全性完全依赖「持有者一定会释放」。若上游挂起时持有者永不释放，容量会被
 *    永久占满，反而比不限并发更糟（从「各自卡」变成「互相拖死」）——这正是 L1（超时兜底）
 *    与 L2（并发闸门）必须同批落地的原因。
 *
 * ── M2c（2026-09-18）：两层**业务**闸门（契约 `docs/TENANCY-SPEC.md` §8.1.3.1）──────
 * 老板原话：「**免费额度是无限的，但是限速，就是不能请求太多，最多同时运行两个对话**」。
 * ⇒ 免费通道**不限额度、只限并发**，且是**两层**：
 *
 *     用户请求 → [内层] 每用户 2 → [外层] 全站封顶 N → 上游
 *
 * ★ **两层职责不同，不能合并成一层**：
 *   · 只做内层 ⇒ 成本敞口**随用户数线性增长**、上游可能被打挂（内层是"每人"，管不住总量）；
 *   · 只做外层 ⇒ 用户之间**互相排队**（10 人同时用、8 人在等）。
 * ★ **分桶键**（契约 §8.1.3.1 第 3 条）：
 *   · 内层 `(baseUrl, ownerId)` —— `ownerId` 是**请求者**，**不是** provider 的 owner。
 *     ★ 这条最容易写反：免费通道的 provider 其 `owner_id` 恒为 `NULL`，若内层按 provider 的
 *     owner 分桶，**所有免费用户会共享一个容量 2 的桶**——那正是加 owner 维度之前的行为
 *     （事实上的"全站 2"），等于加了个寂寞。
 *   · 外层 `baseUrl`。
 * ★ **外层桶必须设队列上限**（契约 §8.1.3.1 第 2 条）：全站封顶时若无限排队，用户看到的是
 *   **无限期转圈**（"卡死"），比明确拒绝更糟 ⇒ 超队列上限直接拒，文案用契约原文
 *   「当前免费通道繁忙，请稍后再试」。
 * ★ **外层只约束免费通道**（契约 §8.1.3.2）：BYOK 用户自带 key、钱不是平台出的，
 *   不该被"免费用户太多"连坐；他们仍受**内层**约束（每用户 2——自己也不会打挂自己的上游）。
 *   ⚠️ 契约 §8.1.3.2 的原话是「BYOK 自带 key ⇒ 不同 `baseUrl` ⇒ 天然落到另一个桶」——
 *   那句只在**两家服务商不同**时成立；用户自带 OpenAI key 时 `baseUrl` 与平台 provider 相同，
 *   桶是同一个。故本条**按"只让外层管平台通道"实现**，把意图落在代码里而不是落在假设上。
 *
 * ★ **`quota` 从哪来**：`router.ts#routeRole` 把 `{ ownerId, platform }` 用 `bindQuota()`
 *   **绑在它返回的 `adapter` 上**，调用方无感。★ 为什么不给 `ChatRequest` 加一个"请记得传"
 *   的字段、也不引 `AsyncLocalStorage`：前者**漏传就静默退化成平台通道**（正是本片要消灭的
 *   bug），后者把"漏设"变成常态（§8.1.4 已用四条理由否掉）。绑在 `routeRole` 的返回值上
 *   **结构上不可能漏**——拿不到 `routeRole` 的返回值就没有 `apiKey`/`baseUrl`，也就发不出请求。
 *   与 ALS 的关键差别：**这里没有"缺省"这个状态**，只有"你走了 `routeRole`"这一条路。
 *
 * ⚠️ 已知边界（诚实记账，契约 §8.1.3.1 第 1 条）：实现是**进程内 `Map`** ⇒
 *   **多实例部署时容量 × 实例数**（每实例各算各的）。单实例下成立；多实例需外部存储
 *   （Redis 等），**本批不做**。
 * ⚠️ **全站封顶 N 是占位值**（待老板给业务值）：`SB_UPSTREAM_SITE_MAX_CONCURRENT`，缺省 8。
 *   契约明说「结构可以先落、外层留 config」。
 */
import type { ChatRequest, LLMAdapter, UpstreamPurpose, UpstreamQuota } from './types.js';

/** 内层：**每个用户**在每个上游同时允许的在飞请求数。2 = 两路对话可并行，且不放开限流意图。 */
export const UPSTREAM_MAX_CONCURRENT = 2;

/** 外层：**全站**在每个上游同时允许的在飞请求数。⚠️ 占位值，待老板给业务值（走 env 可覆盖）。 */
export const UPSTREAM_SITE_MAX_CONCURRENT = readPositiveInt(process.env.SB_UPSTREAM_SITE_MAX_CONCURRENT, 8);

/** 外层桶的排队上限：超出直接拒绝，不让用户无限期转圈（契约 §8.1.3.1 第 2 条）。 */
export const UPSTREAM_SITE_QUEUE_MAX = readPositiveInt(process.env.SB_UPSTREAM_SITE_QUEUE_MAX, 20);

/** 外层桶满员拒绝时的文案（契约 §8.1.3.1 原文，用户看得懂且指向"稍后再试"而不是"你错了"）。 */
export const UPSTREAM_BUSY_MESSAGE = '当前免费通道繁忙，请稍后再试';

/** 排队期间被停止时抛出的错误文案（与 flow 的「已停止」口径一致） */
const QUEUE_ABORT_MESSAGE = '已停止';

/** 缺省配额 = 未登录的**平台**通道（失败安全侧：宁可多限一个匿名请求，也不放跑一笔平台开销）。 */
const DEFAULT_QUOTA: UpstreamQuota = { ownerId: null, platform: true };

/** 读正整数环境变量；非法/缺省回落到 `fallback`（不抛——启动期不该因为一个错字起不来）。 */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** 单个桶的信号量（主链优先、后台让路；可选排队上限） */
class Gate {
  private active = 0;
  private readonly main: Waiter[] = [];
  private readonly background: Waiter[] = [];

  constructor(
    private readonly capacity: number,
    /** 排队上限（`Infinity` = 不限）。★ 只给**外层**桶设：内层是每用户的桶，排队的全是自己的请求。 */
    private readonly queueMax: number = Number.POSITIVE_INFINITY,
  ) {}

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
      // ★ 队列满了就**明确拒绝**，不让用户无限期转圈（比"卡死"好：用户知道该稍后再试）
      if (this.main.length + this.background.length >= this.queueMax) {
        reject(new Error(UPSTREAM_BUSY_MESSAGE));
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

/** 上游端点的兜底桶名（空 `baseUrl` 与"没配"归同一扇门） */
function bucketKey(baseUrl: string): string {
  return baseUrl || 'unknown-upstream';
}

/**
 * 内层桶键 = `(baseUrl, 请求者账号)`。
 * ★ 两个坑都在这儿堵住，否则是**静默串桶**（表现为"我的并发被别人的请求占着"，极难查）：
 *   ① **拼接歧义**：用 `\u0000` 分隔 ⇒ `('ab','c')` 与 `('a','bc')` 不会拼成同一个键；
 *   ② **`null` 与 `''` 必须不同键**：`null` = 未登录本地模式，`''` = 不该出现但若出现
 *      绝不能和"未登录"挤同一个桶 ⇒ `null` 编成 `\u0001`（不是空串）。
 */
function innerKey(baseUrl: string, ownerId: string | null): string {
  return `${bucketKey(baseUrl)}\u0000${ownerId === null ? '\u0001' : ownerId}`;
}

/** 内层：按 `(baseUrl, ownerId)` 分桶，容量 2 */
const innerGates = new Map<string, Gate>();
/** 外层：按 `baseUrl` 分桶，容量 N + 队列上限 */
const outerGates = new Map<string, Gate>();

function gateFor(map: Map<string, Gate>, key: string, capacity: number, queueMax?: number): Gate {
  let gate = map.get(key);
  if (!gate) {
    gate = new Gate(capacity, queueMax);
    map.set(key, gate);
  }
  return gate;
}

/**
 * 取得一个上游配额槽（**两层都过**才拿到）。返回 release 函数（幂等），**必须在 finally 里调用**。
 *
 * ★ 获取顺序**内层先、外层后**：反过来会让一个用户排在自己外层队里时**占着全站名额**——
 *   他一个人的超额请求就能把别人挡在门外。内层先拿 ⇒ 超额请求停在自己的桶里，不牵连他人。
 * ★ 外层拿不到（队列满 / 排队中被中止）时**必须把已拿到的内层槽还回去**，否则内层槽
 *   永久泄漏（该用户此后每次请求都会以为自己已经占满）。
 *
 * @param baseUrl 上游端点（两层都用它分桶）
 * @param purpose 主链（用户在等）还是后台（为下一轮备料）
 * @param signal  调用方中止信号；排队期间被停止会 reject 而不是继续等
 * @param quota   归属维度（缺省 = 未登录的平台通道）。见 `types.UpstreamQuota`
 */
export async function acquireUpstream(
  baseUrl: string,
  purpose: UpstreamPurpose = 'main',
  signal?: AbortSignal,
  quota?: UpstreamQuota,
): Promise<() => void> {
  const q = quota ?? DEFAULT_QUOTA;
  const releaseInner = await gateFor(innerGates, innerKey(baseUrl, q.ownerId), UPSTREAM_MAX_CONCURRENT).acquire(
    purpose,
    signal,
  );
  if (!q.platform) return releaseInner; // BYOK：只受内层约束（§8.1.3.2）
  try {
    const releaseOuter = await gateFor(
      outerGates,
      bucketKey(baseUrl),
      UPSTREAM_SITE_MAX_CONCURRENT,
      UPSTREAM_SITE_QUEUE_MAX,
    ).acquire(purpose, signal);
    return () => {
      releaseOuter();
      releaseInner();
    };
  } catch (err) {
    releaseInner(); // ★ 外层没拿到 ⇒ 把内层还回去，否则该用户的内层槽永久泄漏
    throw err;
  }
}

/**
 * 把配额**绑在适配器上**（M2c）：返回一个只多一件事的适配器——每次 `chat()` 都把 `quota`
 * 塞进请求。`routeRole` 用它对返回值做包装，于是**任何调用点都不可能漏传**（见文件头说明）。
 *
 * ★ 只包装 `chat`：`listModels` 是元数据调用（不花 token、不占上游生成配额），**不闸**。
 * ★ `type` 原样透传：`chat/flow.ts` 据 `target.adapter.type === 'anthropic'` 决定是否开思考链。
 */
export function bindQuota(adapter: LLMAdapter, quota: UpstreamQuota): LLMAdapter {
  return {
    type: adapter.type,
    chat: (req: ChatRequest) => adapter.chat({ ...req, quota }),
    listModels: (config) => adapter.listModels(config),
  };
}

/**
 * 诊断/测试用：某个上游当前的占用快照。
 * ★ 前三个字段是**内层**（`(baseUrl, ownerId)`）的，缺省 `ownerId = null` ⇒ 与加 owner 维度
 *   之前的口径一致（老用例不用改）；`site*` 是**外层**（全站桶）的。
 */
export function upstreamStats(
  baseUrl: string,
  ownerId: string | null = null,
): { inFlight: number; pendingMain: number; pendingBackground: number; siteInFlight: number; sitePending: number } {
  const inner = innerGates.get(innerKey(baseUrl, ownerId))?.stats() ?? { inFlight: 0, pendingMain: 0, pendingBackground: 0 };
  const outer = outerGates.get(bucketKey(baseUrl))?.stats() ?? { inFlight: 0, pendingMain: 0, pendingBackground: 0 };
  return { ...inner, siteInFlight: outer.inFlight, sitePending: outer.pendingMain + outer.pendingBackground };
}

/** 测试用：清空全部闸门（用例之间不串味；生产路径不调用） */
export function resetUpstreamGates(): void {
  innerGates.clear();
  outerGates.clear();
}
