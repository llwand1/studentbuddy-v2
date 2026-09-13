/**
 * llm/openai 出站与呈现形态回归（v13 补上 test-plan §6 记的 P1 欠账）：
 * ① streamMode='once' 一次性回答分支——body.stream=false、完整 JSON 解析成
 *    reasoning + content 两个 chunk、tool_calls 与 usage 随终帧下发；
 * ② 缺省流式分支行为不变（body.stream=true，SSE 增量解析回归）。
 * 手法：桩掉 global fetch，不打真网络。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatibleAdapter } from './openai.js';
import type { TokenChunk } from './types.js';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
  return { ok: true, status: 200, text: async () => '', body: stream };
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
