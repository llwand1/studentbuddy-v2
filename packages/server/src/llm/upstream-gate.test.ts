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
import { acquireUpstream, resetUpstreamGates, UPSTREAM_MAX_CONCURRENT, upstreamStats } from './upstream-gate.js';

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
