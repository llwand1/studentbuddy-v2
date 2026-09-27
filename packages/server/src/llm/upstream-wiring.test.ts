/**
 * 适配器接线回归 —— 本次事故的端到端锁（2026-09-17）。
 *
 * 事故现象：两路会话同时运行时**双双卡在「回复中」**，输入框永久禁用。
 * 根因不在编排层，而在适配层的等待兜底从未生效（详见 `upstream-timeout.ts` 头注释）。
 * 本文件用「永不应答的假上游 + 假时钟」把这条链钉住：
 *   上游挂起 → 空闲超时 → 抛**可读错误**（而非裸 AbortError，更不是永久 pending）。
 *
 * 同时钉住两件容易写错的事：
 * ① 闸门只在 `chat()` 最外层 acquire 一次 —— `streamMode='once'` 转调 `chatOnce()`
 *    是内部调用，若它也 acquire 就会「自己等自己」直接死锁；
 * ② 闸门真的接进了适配器 —— 容量满时第三个请求**不会打到上游**，等兜底释放后才前进。
 *
 * ★ 假响应的关键：必须**响应 abort**。真 fetch 被 abort 时会让响应体/JSON 报错，
 *   若 mock 返回一个与 signal 无关的死流，`reader.read()` 会永远 pending，
 *   那就测不出「兜底是否生效」——只会把用例挂到测试超时（本文件第一版就是这么翻车的）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { resetUpstreamGates } from './upstream-gate.js';
import type { TokenChunk } from './types.js';

const ABORT_MESSAGE = 'This operation was aborted';

/** 挂起流式响应体：不产出任何帧，但**在 abort 时报错**（对齐真 fetch 语义） */
function hangingStream(signal?: AbortSignal | null) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: new ReadableStream<Uint8Array>({
      start(c) {
        if (!signal) return;
        if (signal.aborted) {
          c.error(new Error(ABORT_MESSAGE));
          return;
        }
        signal.addEventListener('abort', () => c.error(new Error(ABORT_MESSAGE)), { once: true });
      },
    }),
  };
}

/** 挂起的一次性响应体：`response.json()` 永不 settle，abort 时 reject */
function hangingJson(signal?: AbortSignal | null) {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: () =>
      new Promise((_resolve, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(new Error(ABORT_MESSAGE));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error(ABORT_MESSAGE)), { once: true });
      }),
  };
}

/** 模拟一次正常的、立刻结束的流式回答 */
function doneStream() {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    }),
  };
}

/** 消费生成器到底；折叠成「成功/失败消息」，避免断言前出现未处理的 rejection */
async function outcome(gen: AsyncIterable<TokenChunk>): Promise<string> {
  try {
    for await (const _ of gen) {
      /* 消费到底 */
    }
    return 'resolved';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function collect(gen: AsyncIterable<TokenChunk>): Promise<TokenChunk[]> {
  const out: TokenChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetUpstreamGates();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('★ 上游挂起必须被兜住（根因回归）', () => {
  it('openai 流式：空闲超时后抛可读错误，而不是永久转圈', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => hangingStream(init?.signal)));
    const adapter = new OpenAICompatibleAdapter();
    // 生产路径**总是**传 signal（aborters 里那个只在用户点停止时才 abort）——
    // 旧实现正是「有 signal 就不设兜底」，所以这条断言必须带 signal 才有判别力
    const signal = new AbortController().signal;

    const run = outcome(
      adapter.chat({
        model: 'm',
        apiKey: 'k',
        baseUrl: 'https://hang-openai.example/v1',
        messages: [{ role: 'user', content: '问' }],
        signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(119_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const message = await run;
    expect(message).toContain('无响应');
    expect(message).toContain('已中止本轮');
  });

  it('anthropic 流式：同样被兜住（两适配器同源改造，不能只修一个）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => hangingStream(init?.signal)));
    const adapter = new AnthropicAdapter();
    const signal = new AbortController().signal;

    const run = outcome(
      adapter.chat({
        model: 'm',
        apiKey: 'k',
        baseUrl: 'https://hang-anthropic.example/v1',
        messages: [{ role: 'user', content: '问' }],
        signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await run).toContain('无响应');
  });

  it('一次性形态：走总时长超时（180s），不会被 120s 空闲阈值提前掐断', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => hangingJson(init?.signal)));
    const adapter = new OpenAICompatibleAdapter();

    const run = outcome(
      adapter.chat({
        model: 'm',
        apiKey: 'k',
        baseUrl: 'https://hang-once.example/v1',
        messages: [{ role: 'user', content: '问' }],
        streamMode: 'once',
      }),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await run).toContain('无响应');
  });

  it('用户主动停止仍报中止，不被兜底改写成「上游故障」', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => hangingStream(init?.signal)));
    const adapter = new OpenAICompatibleAdapter();
    const ac = new AbortController();

    const run = outcome(
      adapter.chat({
        model: 'm',
        apiKey: 'k',
        baseUrl: 'https://stop.example/v1',
        messages: [{ role: 'user', content: '问' }],
        signal: ac.signal,
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    ac.abort();

    const message = await run;
    expect(message).not.toContain('无响应'); // 没被误报成超时
    expect(message.toLowerCase()).toContain('abort');
  });
});

describe('闸门接线', () => {
  it('容量满时第三个请求不打到上游，兜底释放后才前进', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => hangingStream(init?.signal));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAICompatibleAdapter();
    const base = 'https://cap.example/v1';
    const send = () =>
      outcome(
        adapter.chat({ model: 'm', apiKey: 'k', baseUrl: base, messages: [{ role: 'user', content: '问' }] }),
      );

    const first = send();
    const second = send();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const third = send();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchMock).toHaveBeenCalledTimes(2); // ★ 第三个在排队，没有并行打到上游

    await vi.advanceTimersByTimeAsync(120_000); // 兜底放掉前两个
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 队列前进，第三个才发出

    expect(await first).toContain('无响应');
    expect(await second).toContain('无响应');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await third).toContain('无响应');
  });

  it('流结束后释放配额：下一个请求不必等超时', async () => {
    const fetchMock = vi.fn(async () => doneStream());
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAICompatibleAdapter();
    const base = 'https://release.example/v1';
    const send = () =>
      collect(adapter.chat({ model: 'm', apiKey: 'k', baseUrl: base, messages: [{ role: 'user', content: '问' }] }));

    await send();
    await send();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 两次都立刻发出（配额已归还）
  });

  it('once 形态不会因闸门重复获取而死锁', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '完整答案' }, finish_reason: 'stop' }] }),
      })),
    );
    const adapter = new OpenAICompatibleAdapter();
    const chunks = await collect(
      adapter.chat({
        model: 'm',
        apiKey: 'k',
        baseUrl: 'https://once-lock.example/v1',
        messages: [{ role: 'user', content: '问' }],
        streamMode: 'once',
      }),
    );
    expect(chunks.at(-1)?.content).toBe('完整答案');
  });
});

describe('正常长回答不受兜底影响', () => {
  it('每段间隔都在空闲阈值内 → 全程不被掐断（touch 真的在重置计时）', async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '', body })));
    const adapter = new OpenAICompatibleAdapter();
    const encoder = new TextEncoder();

    const run = collect(
      adapter.chat({
        model: 'm',
        apiKey: 'k',
        baseUrl: 'https://slow-but-alive.example/v1',
        messages: [{ role: 'user', content: '问' }],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 3; i++) {
      // 每次空闲 100s（< 120s 阈值，累计 300s）——有数据在流就不该被掐
      await vi.advanceTimersByTimeAsync(100_000);
      ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `段${i}` } }] })}\n\n`));
    }
    await vi.advanceTimersByTimeAsync(0);
    ctrl.close();

    const chunks = await run;
    expect(chunks.map((c) => c.content).join('')).toBe('段0段1段2');
  });
});
