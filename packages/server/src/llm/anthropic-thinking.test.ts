/**
 * llm/anthropic 原生思考链回归（v13 体验升级）：
 * ① thinking 开启时出站体带 thinking 块、temperature 摘除（Anthropic 契约：不摘即 400）、
 *    max_tokens 抬到必须大于思考预算；
 * ② thinking + 工具循环：assistant(tool_use) 轮把上一轮思考链作为 thinking 块回灌
 *   （不回传即 400——这是 Anthropic 强制，不是可选优化）；
 * ③ thinking_delta 流式解析成 reasoning chunk；④ listModels 真实现。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AnthropicAdapter } from './anthropic.js';
import type { ChatMessage, TokenChunk } from './types.js';

type OutBody = {
  model: string;
  temperature?: number;
  max_tokens?: number;
  thinking?: { type: string; budget_tokens: number };
  messages: Array<{ role: string; content: unknown }>;
};

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

describe('出站体：thinking 开关', () => {
  it('req.thinking 时 body 带 thinking 块、temperature 摘除、max_tokens 抬过预算', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AnthropicAdapter();
    await collect(
      adapter.chat({
        model: 'claude-sonnet-4-5',
        apiKey: 'k',
        messages: [{ role: 'user', content: '问' }],
        thinking: true,
        maxTokens: 8192,
        temperature: 0.5,
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as OutBody;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(body.temperature).toBeUndefined(); // thinking 开启时 temperature 只允许 1，摘除最稳
    expect(body.max_tokens).toBeGreaterThanOrEqual(12288); // 必须大于思考预算，否则 400
  });

  it('未开 thinking 时出站体不带 thinking、temperature 保留（行为不变回归）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AnthropicAdapter();
    await collect(
      adapter.chat({
        model: 'claude-sonnet-4-5',
        apiKey: 'k',
        messages: [{ role: 'user', content: '问' }],
        temperature: 0.5,
        maxTokens: 8192,
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as OutBody;
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(8192);
  });

  it('thinking + 工具循环：assistant(tool_use) 轮把上一轮思考链回灌为 thinking 块（缺了即 400）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AnthropicAdapter();
    const messages: ChatMessage[] = [
      { role: 'user', content: '问' },
      {
        role: 'assistant',
        content: '',
        reasoning: '上一轮的思考',
        toolCalls: [{ id: 'toolu_1', name: 'search_web', arguments: '{"query":"闭包"}' }],
      },
      { role: 'tool', content: '搜索结果', toolCallId: 'toolu_1' },
    ];
    await collect(adapter.chat({ model: 'claude-sonnet-4-5', apiKey: 'k', messages, thinking: true }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as OutBody;
    const assistant = body.messages.find((m) => m.role === 'assistant');
    expect(Array.isArray(assistant?.content)).toBe(true);
    const blocks = assistant?.content as Array<{ type: string; thinking?: string }>;
    expect(blocks[0]?.type).toBe('thinking'); // 思考块必须在 tool_use 之前
    expect(blocks[0]?.thinking).toBe('上一轮的思考');
    expect(blocks.map((b) => b.type)).toContain('tool_use');
  });

  it('未开 thinking 时消息里的 reasoning 不进出站体（老语义不变）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new AnthropicAdapter();
    const messages: ChatMessage[] = [
      { role: 'user', content: '问' },
      {
        role: 'assistant',
        content: '',
        reasoning: '残留的思考',
        toolCalls: [{ id: 'toolu_1', name: 'search_web', arguments: '{}' }],
      },
    ];
    await collect(adapter.chat({ model: 'claude-sonnet-4-5', apiKey: 'k', messages }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body)) as OutBody;
    const assistant = body.messages.find((m) => m.role === 'assistant');
    const blocks = assistant?.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).not.toContain('thinking');
  });
});

describe('入站流：thinking_delta 解析', () => {
  it('thinking_delta 逐帧吐 reasoning，text_delta 照旧吐正文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想"}}\n\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        ]),
      ),
    );
    const adapter = new AnthropicAdapter();
    const chunks = await collect(
      adapter.chat({
        model: 'claude-sonnet-4-5',
        apiKey: 'k',
        messages: [{ role: 'user', content: '问' }],
        thinking: true,
      }),
    );
    expect(chunks[0]).toMatchObject({ reasoning: '先想', content: '', done: false });
    expect(chunks[1]).toMatchObject({ content: '答案', done: false });
    expect(chunks[chunks.length - 1]?.done).toBe(true);
  });
});

describe('listModels（真实 /models 端点，替换写死桩）', () => {
  it('解析 data[].id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-x' }, { id: 'claude-y' }] }) })),
    );
    const models = await new AnthropicAdapter().listModels({ apiKey: 'k' });
    expect(models).toEqual(['claude-x', 'claude-y']);
  });

  it('失败返回空数组（调用方保持手填输入框可用，不抛）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    await expect(new AnthropicAdapter().listModels({ apiKey: 'k' })).resolves.toEqual([]);
  });
});
