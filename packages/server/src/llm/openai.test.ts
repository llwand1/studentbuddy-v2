/**
 * llm/openai 出站与呈现形态回归（v13 补上一处早先的欠账）：
 * ① streamMode='once' 一次性回答分支——body.stream=false、完整 JSON 解析成
 *    reasoning + content 两个 chunk、tool_calls 与 usage 随终帧下发；
 * ② 缺省流式分支行为不变（body.stream=true，SSE 增量解析回归）。
 * 手法：桩掉 global fetch，不打真网络。
 */
import { beforeEach, describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai.js';
import { NOOP_PLATFORM_METER } from './platform-quota.js';
import { resetUpstreamGates, setPlatformMeter } from './upstream-gate.js';
import type { ChatRequest, TokenChunk } from './types.js';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return { ok: true, status: 200, text: async (): Promise<string> => '', body: stream };
}

async function collect(gen: AsyncIterable<TokenChunk>): Promise<TokenChunk[]> {
  const out: TokenChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('一次性回答分支（streamMode=once，池中 AI 形态）', () => {
  it('发非流式请求，完整答案拆成 reasoning + 终帧（content/toolCalls/usage）两个 chunk', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '完整答案',
              reasoning_content: '想了一下',
              tool_calls: [{ id: 'call_1', function: { name: 'search_web', arguments: '{"query":"闭包"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAICompatibleAdapter();
    const chunks = await collect(
      adapter.chat({
        model: 'relay-model',
        apiKey: 'k',
        messages: [{ role: 'user', content: '问' }],
        streamMode: 'once',
      }),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ reasoning: '想了一下', done: false });
    expect(chunks[1]).toMatchObject({
      content: '完整答案',
      done: true,
      finishReason: 'tool_calls',
      usage: { promptTokens: 11, completionTokens: 22 },
    });
    expect(chunks[1]?.toolCalls).toEqual([
      { id: 'call_1', name: 'search_web', arguments: '{"query":"闭包"}' },
    ]);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(false); // 一次性 = 非流式请求
    expect(body.stream_options).toBeUndefined(); // include_usage 是流式专属，别发给不认它的网关
  });

  it('网关报错时抛出（状态码 + 响应体进错误信息，不静默吞）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, text: async () => 'bad gateway' })),
    );
    const adapter = new OpenAICompatibleAdapter();
    await expect(
      collect(adapter.chat({ model: 'm', apiKey: 'k', messages: [{ role: 'user', content: '问' }], streamMode: 'once' })),
    ).rejects.toThrow('502');
  });
});

describe('缺省流式分支（行为不变回归）', () => {
  it('缺省仍发流式请求并逐帧解析', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAICompatibleAdapter();
    const chunks = await collect(
      adapter.chat({ model: 'm', apiKey: 'k', messages: [{ role: 'user', content: '问' }] }),
    );

    expect(chunks[0]?.content).toBe('你');
    const last = chunks[chunks.length - 1];
    expect(last?.done).toBe(true);
    expect(last?.usage).toEqual({ promptTokens: 1, completionTokens: 2 });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
  });
});

// ── 2026-10-02：平台通道**失败换路**（契约 `docs/TENANCY-SPEC.md` §8.1.3.5）──────────
// 现象背景：线上 3 路里两把免费 key 约 12 发即限速（实测 60 发 48–49 个 429），随机分配把
// 约 2/3 请求摊到必限速路 ⇒ 用户看到 429。改为「按 env 顺序优先 + 失败自动换下一路」。
// 下面用 fetch 桩把「真的会发第二路、且第二发用的是**第二路的 key/baseUrl**」钉死。
// ★ 纪律：纯逻辑——注入 `NOOP_PLATFORM_METER`（不落库、不碰闸门计量），env 用完还原。

const PLATFORM_ENV_KEYS = ['SB_PLATFORM_API_KEY', 'SB_PLATFORM_BASE_URL'] as const;

describe('v20261002 平台通道失败换路', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of PLATFORM_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    resetUpstreamGates();
    setPlatformMeter(NOOP_PLATFORM_METER);
  });

  afterEach(() => {
    for (const k of PLATFORM_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    setPlatformMeter(null);
  });

  /** 配两条平台路（第一路＝主力），与线上多路同形。 */
  function twoPlatformRoutes(): void {
    process.env.SB_PLATFORM_API_KEY = 'sk-test-primary,sk-test-backup';
    process.env.SB_PLATFORM_BASE_URL = 'https://primary.example/v1,https://backup.example/v1';
  }

  /** 一个平台请求（第一发打主力；`quota.platform=true` 才启用换路）。 */
  function platformReq(over?: Partial<ChatRequest>): ChatRequest {
    return {
      model: 'm',
      apiKey: 'sk-test-primary',
      baseUrl: 'https://primary.example/v1',
      messages: [{ role: 'user', content: '问' }],
      quota: { ownerId: 'u1', platform: true },
      ...over,
    };
  }

  it('★ 第一路 429 ⇒ 换第二路：发两发，第二发用第二路的 baseUrl 与 key，最终正常返回', async () => {
    twoPlatformRoutes();
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).startsWith('https://primary.example/v1')) {
        return { ok: false, status: 429, text: async (): Promise<string> => 'rate limited' };
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const chunks = await collect(new OpenAICompatibleAdapter().chat(platformReq()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://primary.example/v1/chat/completions');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://backup.example/v1/chat/completions');
    const init2 = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect((init2?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer sk-test-backup');
    expect(chunks.map((c) => c.content).join('')).toContain('好');
  });

  it('★ 两路都 500 ⇒ 发两发后抛出（不无限重试）', async () => {
    twoPlatformRoutes();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(collect(new OpenAICompatibleAdapter().chat(platformReq()))).rejects.toThrow('500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('★ BYOK（platform=false）429 ⇒ 只发一发就抛，且打的是自己的地址（不换路）', async () => {
    twoPlatformRoutes(); // 即便 env 有多路，BYOK 也不许用它们
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: false, status: 429, text: async (): Promise<string> => 'rate limited' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      collect(
        new OpenAICompatibleAdapter().chat(
          platformReq({ quota: { ownerId: 'u1', platform: false }, apiKey: 'sk-test-byok', baseUrl: 'https://byok.example/v1' }),
        ),
      ),
    ).rejects.toThrow('429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://byok.example/v1/chat/completions');
  });

  it('★ 用户取消 ⇒ 只发一发、立即抛，不换路', async () => {
    twoPlatformRoutes();
    const ac = new AbortController();
    ac.abort();
    const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const fetchMock = vi.fn(async () => {
      throw abortErr;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(collect(new OpenAICompatibleAdapter().chat(platformReq({ signal: ac.signal })))).rejects.toThrow(
      /abort/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('★ 流式中途出错**不换路**：已吐字节 ⇒ 原样抛、只发一发（否则用户会看到重复内容）', async () => {
    twoPlatformRoutes();
    // 每次 fetch 现造一个流：第一次 read 吐一段正文（⇒ 已向客户端吐字节），第二次 read 报错。
    const fetchMock = vi.fn(async () => {
      const encoder = new TextEncoder();
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          n += 1;
          if (n === 1) c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"前"}}]}\n\n'));
          else c.error(new Error('mid-stream boom'));
        },
      });
      return { ok: true, status: 200, text: async (): Promise<string> => '', body };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(collect(new OpenAICompatibleAdapter().chat(platformReq()))).rejects.toThrow('mid-stream boom');
    expect(fetchMock).toHaveBeenCalledTimes(1); // ★ 吐过字节就不再换路
  });

  it('★ 候选只有一路 ⇒ 与从前逐字相同：成功照常；429 也只发一发、不无限重试', async () => {
    process.env.SB_PLATFORM_API_KEY = 'sk-test-only';
    process.env.SB_PLATFORM_BASE_URL = 'https://only.example/v1';
    const req = platformReq({ apiKey: 'sk-test-only', baseUrl: 'https://only.example/v1' });

    const ok = vi.fn(async () => sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', ok);
    const chunks = await collect(new OpenAICompatibleAdapter().chat(req));
    expect(ok).toHaveBeenCalledTimes(1);
    expect(chunks.at(-1)?.done).toBe(true);

    resetUpstreamGates();
    const bad = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rl' }));
    vi.stubGlobal('fetch', bad);
    await expect(collect(new OpenAICompatibleAdapter().chat(req))).rejects.toThrow('429');
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
