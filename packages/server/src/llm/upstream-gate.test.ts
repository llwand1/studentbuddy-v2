/**
 * llm/upstream-gate 回归：上游并发闸门（主链优先、后台让路）。
 *
 * 背景（诊断全文 `_probe/DIAGNOSIS.md`）：两路会话同时对话时双双卡在「回复中」。
 * 除「上游挂起无兜底」这个根因外，第二层原因是**配额踩踏**——每轮对话结束后固定追加
 * 两次后台 LLM 调用（词条抽取 → 会话内压缩），实测可见它们「立刻抢走刚空出的配额」，
 * 让被挂起的会话更难恢复。本闸门就是给这件事立的规矩。
 *
 * 全部为纯逻辑断言，不打网络、不起真定时器。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireUpstream,
  bindQuota,
  resetUpstreamGates,
  setPlatformMeter,
  UPSTREAM_BUSY_MESSAGE,
  UPSTREAM_MAX_CONCURRENT,
  UPSTREAM_SITE_MAX_CONCURRENT,
  UPSTREAM_SITE_QUEUE_MAX,
  upstreamStats,
} from './upstream-gate.js';
import { NOOP_PLATFORM_METER } from './platform-quota.js';
import type { LLMAdapter, UpstreamQuota } from './types.js';

const URL_A = 'https://upstream-a.example/v1';
const URL_B = 'https://upstream-b.example/v1';

/** 冲掉微任务队列：闸门的放行/拒绝都经 Promise，断言前要给它跑完的机会 */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** 发起一次获取但**不阻塞**，返回一个可读的「是否已放行」句柄 */
function probe(baseUrl: string, purpose: 'main' | 'background' = 'main', signal?: AbortSignal) {
  const state: { admitted: boolean; release?: () => void; error?: Error } = { admitted: false };
  void acquireUpstream(baseUrl, purpose, signal).then(
    (release) => {
      state.admitted = true;
      state.release = release;
    },
    (err: Error) => {
      state.error = err;
    },
  );
  return state;
}

beforeEach(() => {
  resetUpstreamGates();
  // ★ v39（2026-09-21）：本文件是**纯逻辑**用例，绝不落库。
  //   下面「按 owner 分桶」那组带的配额是 `{ ownerId: 'A', platform: true }`——恰是会被
  //   次数配额计量的那一态。不换掉计量器的话，这里 60 来次 acquire 会打开并迁移
  //   **老板的真实库**（`getDb()` 懒加载真实数据目录），既违反 ADR-6「不碰用户数据」，
  //   又会与正在跑的 dev server 争 WAL 写锁 ⇒ 随机红。计量器本身的正确性由
  //   `platform-quota.test.ts`（隔离库）负责，本文件只测**并发闸门**。
  setPlatformMeter(NOOP_PLATFORM_METER);
});

describe('并发上限', () => {
  it('容量 2：第三路排队等待，不会并行打到上游', async () => {
    const r1 = await acquireUpstream(URL_A);
    const r2 = await acquireUpstream(URL_A);
    expect(upstreamStats(URL_A).inFlight).toBe(UPSTREAM_MAX_CONCURRENT);

    const third = probe(URL_A);
    await tick();
    expect(third.admitted).toBe(false);
    expect(upstreamStats(URL_A).pendingMain).toBe(1);

    r1();
    await tick();
    expect(third.admitted).toBe(true);
    r2();
    third.release?.();
  });

  it('容量是「两路对话可并行」的下限，不是 1（给 1 会把两路对话焊成串行）', () => {
    expect(UPSTREAM_MAX_CONCURRENT).toBe(2);
  });

  it('释放后队列前进（FIFO）', async () => {
    const r1 = await acquireUpstream(URL_A);
    const r2 = await acquireUpstream(URL_A);
    const first = probe(URL_A);
    const second = probe(URL_A);
    await tick();
    expect(upstreamStats(URL_A).pendingMain).toBe(2);

    r1();
    await tick();
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(false);

    r2();
    await tick();
    expect(second.admitted).toBe(true);
    first.release?.();
    second.release?.();
  });

  it('release 幂等：重复调用不会把容量还两次', async () => {
    const release = await acquireUpstream(URL_A);
    release();
    release();
    release();
    expect(upstreamStats(URL_A).inFlight).toBe(0);
  });
});

describe('主链优先、后台让路', () => {
  it('后台先排队，主链后到 —— 先放行的是主链', async () => {
    const r1 = await acquireUpstream(URL_A);
    const r2 = await acquireUpstream(URL_A);

    const bg = probe(URL_A, 'background');
    await tick();
    const main = probe(URL_A, 'main');
    await tick();
    expect(bg.admitted).toBe(false);
    expect(main.admitted).toBe(false);

    r1(); // 空出一个槽：应让给主链，而不是先到的后台
    await tick();
    expect(main.admitted).toBe(true);
    expect(bg.admitted).toBe(false);

    r2();
    await tick();
    expect(bg.admitted).toBe(true);

    main.release?.();
    bg.release?.();
  });

  it('槽位有空时后台不必等（只在主链排队时才让路）', async () => {
    const bg = probe(URL_A, 'background');
    await tick();
    expect(bg.admitted).toBe(true);
    bg.release?.();
  });

  it('后台不得越过排队中的主链 —— 连续放行两次也守住顺序', async () => {
    const r1 = await acquireUpstream(URL_A);
    const r2 = await acquireUpstream(URL_A);
    const main = probe(URL_A, 'main');
    await tick();
    const bg = probe(URL_A, 'background');
    await tick();

    r1();
    r2();
    await tick();
    expect(main.admitted).toBe(true);
    expect(bg.admitted).toBe(true);
    main.release?.();
    bg.release?.();
  });
});

describe('排队期间被停止', () => {
  it('排队中 abort：立即拒绝并从队列移除（不占着位子等一个不会来的放行）', async () => {
    const r1 = await acquireUpstream(URL_A);
    const r2 = await acquireUpstream(URL_A);
    const ac = new AbortController();

    const waiter = acquireUpstream(URL_A, 'main', ac.signal);
    await tick();
    expect(upstreamStats(URL_A).pendingMain).toBe(1);

    ac.abort();
    await expect(waiter).rejects.toThrow('已停止');
    expect(upstreamStats(URL_A).pendingMain).toBe(0);

    r1();
    r2();
  });

  it('已中止的信号不排队，直接拒绝', async () => {
    const r1 = await acquireUpstream(URL_A);
    const r2 = await acquireUpstream(URL_A);
    const ac = new AbortController();
    ac.abort();

    await expect(acquireUpstream(URL_A, 'main', ac.signal)).rejects.toThrow('已停止');
    expect(upstreamStats(URL_A).pendingMain).toBe(0);
    r1();
    r2();
  });

  it('被放行之后 abort 不再影响它（那是请求自己的事，由超时兜底管）', async () => {
    const ac = new AbortController();
    const release = await acquireUpstream(URL_A, 'main', ac.signal);
    ac.abort();
    expect(upstreamStats(URL_A).inFlight).toBe(1);
    release();
    expect(upstreamStats(URL_A).inFlight).toBe(0);
  });
});

describe('闸门按上游端点分桶', () => {
  it('两个不同 baseUrl 各自计数，互不占位', async () => {
    const a = await acquireUpstream(URL_A);
    const b = await acquireUpstream(URL_B);
    expect(upstreamStats(URL_A).inFlight).toBe(1);
    expect(upstreamStats(URL_B).inFlight).toBe(1);
    a();
    b();
  });

  it('同一个上游的两条配置共享闸门（配额是上游的，不是配置记录的）', async () => {
    const a1 = await acquireUpstream(URL_A);
    const a2 = await acquireUpstream(URL_A);
    const third = probe(URL_A);
    await tick();
    expect(third.admitted).toBe(false);
    a1();
    a2();
    await tick();
    expect(third.admitted).toBe(true);
    third.release?.();
  });

  it('空 baseUrl 归入同一个兜底桶，不会各自开一扇门', async () => {
    const x = await acquireUpstream('');
    const y = await acquireUpstream('');
    const third = probe('');
    await tick();
    expect(third.admitted).toBe(false);
    x();
    y();
    await tick();
    expect(third.admitted).toBe(true);
    third.release?.();
  });
});

// ── M2c（2026-09-18）：两层业务闸门（契约 `docs/TENANCY-SPEC.md` §8.1.3.1）──────────
// 内层「每用户 2」保体验、外层「全站封顶 N」保成本与上游。★ 两层的分桶键**不同**：
// 内层 `(baseUrl, 请求者)`、外层 `baseUrl`——写成同一层或同一键，下面必有红。

/** 造一个配额：`owner` = **请求者**账号；`platform` = 是否平台付钱 */
const q = (owner: string | null, platform = true): UpstreamQuota => ({ ownerId: owner, platform });

/** 带配额的探针（同 `probe`，多一个 quota） */
function probeQ(baseUrl: string, quota: UpstreamQuota) {
  const state: { admitted: boolean; release?: () => void; error?: Error } = { admitted: false };
  void acquireUpstream(baseUrl, 'main', undefined, quota).then(
    (release) => {
      state.admitted = true;
      state.release = release;
    },
    (err: Error) => {
      state.error = err;
    },
  );
  return state;
}

describe('M2c 内层：每用户 2 —— 按**请求者**分桶，不按 provider 的 owner', () => {
  it('★ A 占满 2 个不影响 B（免费通道的 provider owner 都是 NULL，按它分桶这里必红）', async () => {
    const a1 = await acquireUpstream(URL_A, 'main', undefined, q('A'));
    const a2 = await acquireUpstream(URL_A, 'main', undefined, q('A'));
    expect(upstreamStats(URL_A, 'A').inFlight).toBe(UPSTREAM_MAX_CONCURRENT);

    const b1 = probeQ(URL_A, q('B'));
    await tick();
    expect(b1.admitted).toBe(true); // ★ B 立刻放行，而不是排在 A 后面
    expect(upstreamStats(URL_A, 'B').inFlight).toBe(1);

    a1();
    a2();
    b1.release?.();
  });

  it('同一个人第三路仍然排队（内层容量仍是 2）', async () => {
    const a1 = await acquireUpstream(URL_A, 'main', undefined, q('A'));
    const a2 = await acquireUpstream(URL_A, 'main', undefined, q('A'));
    const third = probeQ(URL_A, q('A'));
    await tick();
    expect(third.admitted).toBe(false);
    expect(upstreamStats(URL_A, 'A').pendingMain).toBe(1);
    a1();
    await tick();
    expect(third.admitted).toBe(true);
    a2();
    third.release?.();
  });

  it('未登录（null）与空串账号**不挤同一个桶**（拼接歧义与 null/空串歧义都要堵）', async () => {
    const anon = await acquireUpstream(URL_A, 'main', undefined, q(null));
    const empty = await acquireUpstream(URL_A, 'main', undefined, q(''));
    expect(upstreamStats(URL_A, null).inFlight).toBe(1);
    expect(upstreamStats(URL_A, '').inFlight).toBe(1);
    expect(upstreamStats(URL_A, '').pendingMain).toBe(0); // 撞桶的话它会排在这里
    anon();
    empty();
  });

  it('★ 获取顺序内层先：一个人超额时不占全站名额（外层计数与队列都不涨）', async () => {
    const a1 = await acquireUpstream(URL_A, 'main', undefined, q('A'));
    const a2 = await acquireUpstream(URL_A, 'main', undefined, q('A'));
    expect(upstreamStats(URL_A).siteInFlight).toBe(2);

    const third = probeQ(URL_A, q('A')); // 停在内层队列里
    await tick();
    expect(third.admitted).toBe(false);
    expect(upstreamStats(URL_A).siteInFlight).toBe(2); // ★ 没多占外层
    expect(upstreamStats(URL_A).sitePending).toBe(0); // ★ 也没排进外层队列

    a1();
    a2();
    await tick();
    third.release?.();
  });
});

describe('M2c 外层：全站封顶 N + 队列上限（只约束平台通道）', () => {
  /** 用 N 个**不同**用户填满外层桶（每个用户各自只占 1，故内层不会先挡住它们） */
  async function fillSite(): Promise<Array<() => void>> {
    const held: Array<() => void> = [];
    for (let i = 0; i < UPSTREAM_SITE_MAX_CONCURRENT; i++) {
      held.push(await acquireUpstream(URL_A, 'main', undefined, q(`u${i}`)));
    }
    return held;
  }

  it('全站桶到 N 就不再并行打到上游（第 N+1 个排队）', async () => {
    const held = await fillSite();
    expect(upstreamStats(URL_A).siteInFlight).toBe(UPSTREAM_SITE_MAX_CONCURRENT);

    const extra = probeQ(URL_A, q('u-extra'));
    await tick();
    expect(extra.admitted).toBe(false);
    expect(upstreamStats(URL_A).sitePending).toBe(1);

    const [releaseFirst, ...rest] = held;
    releaseFirst?.();
    await tick();
    expect(extra.admitted).toBe(true);

    rest.forEach((r) => r());
    extra.release?.();
  });

  it('★ 外层队列满 ⇒ 明确拒绝（不让用户无限期转圈），文案是契约原文', async () => {
    const held = await fillSite();
    const queued: Array<ReturnType<typeof probeQ>> = [];
    for (let i = 0; i < UPSTREAM_SITE_QUEUE_MAX; i++) queued.push(probeQ(URL_A, q(`w${i}`)));
    await tick();
    expect(upstreamStats(URL_A).sitePending).toBe(UPSTREAM_SITE_QUEUE_MAX);

    const overflow = probeQ(URL_A, q('overflow'));
    await tick();
    expect(overflow.admitted).toBe(false);
    expect(overflow.error?.message).toBe(UPSTREAM_BUSY_MESSAGE);

    held.forEach((r) => r());
    await tick();
  });

  it('★ 外层被拒时内层槽必须还回去（否则该用户的内层槽永久泄漏）', async () => {
    const held = await fillSite();
    for (let i = 0; i < UPSTREAM_SITE_QUEUE_MAX; i++) probeQ(URL_A, q(`w${i}`));
    await tick();

    const victim = probeQ(URL_A, q('victim'));
    await tick();
    expect(victim.error?.message).toBe(UPSTREAM_BUSY_MESSAGE);
    expect(upstreamStats(URL_A, 'victim').inFlight).toBe(0); // ★ 已归还

    held.forEach((r) => r());
    await tick();
  });

  it('★ BYOK（platform=false）不受外层约束：平台桶打满时仍能放行（§8.1.3.2）', async () => {
    const held = await fillSite();
    const byok = probeQ(URL_A, q('byok-user', false));
    await tick();
    expect(byok.admitted).toBe(true); // ★ 没被"免费用户太多"连坐
    expect(upstreamStats(URL_A).siteInFlight).toBe(UPSTREAM_SITE_MAX_CONCURRENT); // 也没占外层

    held.forEach((r) => r());
    byok.release?.();
  });

  it('常量不变式：外层不得小于内层（否则一个用户连自己那 2 个槽都用不满）', () => {
    expect(UPSTREAM_SITE_MAX_CONCURRENT).toBeGreaterThanOrEqual(UPSTREAM_MAX_CONCURRENT);
    expect(UPSTREAM_SITE_QUEUE_MAX).toBeGreaterThanOrEqual(1);
  });
});

describe('M2c bindQuota：配额绑在适配器上（调用方结构上不可能漏传）', () => {
  function spyAdapter(seen: Array<UpstreamQuota | undefined>): LLMAdapter {
    return {
      type: 'anthropic',
      chat: (req) => {
        seen.push(req.quota);
        return (async function* () {})();
      },
      listModels: async () => ['m1'],
    };
  }

  it('每次 chat 都塞进配额，且 `type` / `listModels` 原样透传', async () => {
    const seen: Array<UpstreamQuota | undefined> = [];
    const bound = bindQuota(spyAdapter(seen), { ownerId: 'u1', platform: true });
    expect(bound.type).toBe('anthropic');
    for await (const _chunk of bound.chat({ model: 'm', apiKey: 'k', messages: [] })) void _chunk;
    expect(seen).toEqual([{ ownerId: 'u1', platform: true }]);
    expect(await bound.listModels()).toEqual(['m1']);
  });

  it('调用方自己传的 quota 会被绑定的那份覆盖（绑定的才是权威）', async () => {
    const seen: Array<UpstreamQuota | undefined> = [];
    const bound = bindQuota(spyAdapter(seen), { ownerId: 'real', platform: false });
    for await (const _chunk of bound.chat({
      model: 'm',
      apiKey: 'k',
      messages: [],
      quota: { ownerId: 'forged', platform: true },
    })) {
      void _chunk;
    }
    expect(seen).toEqual([{ ownerId: 'real', platform: false }]);
  });
});
