/**
 * llm/anthropic 出站请求体回归。
 * 两件事：① 多条 system 必须全部下发（旧实现只发第一条）；
 * ② test-plan §6 首笔记的结构性欠账——适配器层对「发给模型的 body」零断言。
 * 手法：桩掉 global fetch，把 init.body 解出来逐字段钉死，不打真网络。
 */
import { beforeEach, describe, it, expect, afterEach, vi } from 'vitest';
import { AnthropicAdapter } from './anthropic.js';
import { NOOP_PLATFORM_METER } from './platform-quota.js';
import { resetUpstreamGates, setPlatformMeter } from './upstream-gate.js';
import type { ChatMessage, ChatRequest, ToolDefinition } from './types.js';

type OutBody = {
  model: string;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
};

/** 空 SSE：只够让适配器把请求发出去并正常收尾，出站体才是本文件的断言对象 */
function emptyResponse() {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined as Uint8Array | undefined }),
      }),
    },
  };
}

async function outbound(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<OutBody> {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => emptyResponse());
  vi.stubGlobal('fetch', fetchMock);
  const adapter = new AnthropicAdapter();
  for await (const chunk of adapter.chat({ model: 'claude-sonnet-4-5', apiKey: 'k', messages, tools })) {
    if (chunk.done) break;
  }
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as OutBody;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('system 段合并回归', () => {
  it('本轮学习记录在偏好之后仍完整下发，且不混入普通消息', async () => {
    const body = await outbound([
      { role: 'system', content: '学习回复结构' }, { role: 'user', content: '闭包是什么' },
      { role: 'system', content: '表达偏好段' }, { role: 'system', content: '【本轮相关学习记录】三题正确，讲边界' },
    ]);
    expect(body.system).toBe('学习回复结构\n\n表达偏好段\n\n【本轮相关学习记录】三题正确，讲边界');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe('user');
  });
  it('多条 system 全部合并进 body.system，顺序保持、用空行分隔', async () => {
    const body = await outbound([
      { role: 'system', content: '基础提示词' },
      { role: 'user', content: '问' },
      { role: 'system', content: '忆域词条段' },
      { role: 'system', content: '文档资料段' },
    ]);
    expect(body.system).toContain('基础提示词');
    expect(body.system).toContain('忆域词条段');
    expect(body.system).toContain('文档资料段');
    expect(body.system).toBe('基础提示词\n\n忆域词条段\n\n文档资料段');
  });

  // 回答方式偏好段是第四条 system（flow.ts 恒注入）——漏发即设置页与弹卡选的档位对模型无效
  it('四条 system 仍全部下发，顺序保持、用空行分隔', async () => {
    const body = await outbound([
      { role: 'system', content: '基础提示词' },
      { role: 'user', content: '问' },
      { role: 'system', content: '忆域词条段' },
      { role: 'system', content: '文档资料段' },
      { role: 'system', content: '表达偏好段' },
    ]);
    expect(body.system).toContain('表达偏好段');
    expect(body.system).toBe(['基础提示词', '忆域词条段', '文档资料段', '表达偏好段'].join('\n\n'));
    // system 一律走 body.system，第四条也不许混进 messages（混入即 API 400）
    expect(body.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('system 只走 body.system，绝不混进 messages（混入即 API 400）', async () => {
    const body = await outbound([
      { role: 'system', content: 'S1' },
      { role: 'user', content: 'U' },
      { role: 'system', content: 'S2' },
      { role: 'assistant', content: 'A' },
    ]);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('单条 system 语义与修复前一致', async () => {
    const body = await outbound([{ role: 'system', content: '只有我' }, { role: 'user', content: 'U' }]);
    expect(body.system).toBe('只有我');
  });

  it('无 system 时不下发 system 字段（而非空串）', async () => {
    const body = await outbound([{ role: 'user', content: 'U' }]);
    expect('system' in body).toBe(false);
  });

  it('空 content 的 system 段被过滤，不产生多余空行', async () => {
    const body = await outbound([
      { role: 'system', content: '' },
      { role: 'system', content: '有内容' },
      { role: 'user', content: 'U' },
    ]);
    expect(body.system).toBe('有内容');
  });
});

describe('出站请求体其余字段（适配器零断言欠账清偿）', () => {
  it('tool 结果回灌为 user + tool_result（Anthropic 不接受 role:tool）', async () => {
    const body = await outbound([
      { role: 'user', content: '查一下' },
      { role: 'tool', content: 'F=ma', toolCallId: 'call_1' },
    ]);
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'F=ma' }],
    });
  });

  it('assistant 的 tool_calls 转成 text + tool_use 内容块，arguments 解析为对象', async () => {
    const body = await outbound([
      {
        role: 'assistant',
        content: '我先查一下',
        toolCalls: [{ id: 'call_1', name: 'search_web', arguments: '{"query":"牛顿"}' }],
      },
    ]);
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: '我先查一下' },
      { type: 'tool_use', id: 'call_1', name: 'search_web', input: { query: '牛顿' } },
    ]);
  });

  it('坏 JSON 的 arguments 兜底成空对象而非抛错', async () => {
    const body = await outbound([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'search_web', arguments: '{oops' }] },
    ]);
    const blocks = body.messages[0]?.content as Array<{ input: unknown }>;
    expect(blocks[0]?.input).toEqual({});
  });

  it('max_tokens 必发（Anthropic 缺失即 400），stream/temperature 齐备', async () => {
    const body = await outbound([{ role: 'user', content: 'U' }]);
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBe(0.7);
  });

  it('OpenAI 形态 tools 映射为 Anthropic input_schema；无工具时不下发 tools', async () => {
    const withTools = await outbound([{ role: 'user', content: 'U' }], [
      { type: 'function', function: { name: 'search_web', description: '联网搜索', parameters: { type: 'object', properties: {} } } },
    ]);
    expect(withTools.tools).toEqual([
      { name: 'search_web', description: '联网搜索', input_schema: { type: 'object', properties: {} } },
    ]);
    const withoutTools = await outbound([{ role: 'user', content: 'U' }]);
    expect('tools' in withoutTools).toBe(false);
  });
});

// ── 2026-10-02：平台通道**失败换路**（契约 `docs/TENANCY-SPEC.md` §8.1.3.5）──────────
// 与 `openai.test.ts` 同源口径：平台行按 env 顺序优先、失败换下一路；BYOK/单路/吐字节后不换。
// ★ 纪律：纯逻辑——注入 `NOOP_PLATFORM_METER`，env 用完还原。

/** Anthropic 版 SSE 成功响应：一段正文 + message_delta 收口。 */
function anthSseResponse() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"text":"好"}}\n\n'));
      c.enqueue(encoder.encode('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
      c.close();
    },
  });
  return { ok: true, status: 200, text: async (): Promise<string> => '', body: stream };
}

async function collectAnth(gen: AsyncIterable<{ content: string; done: boolean }>): Promise<Array<{ content: string; done: boolean }>> {
  const out: Array<{ content: string; done: boolean }> = [];
  for await (const c of gen) out.push(c);
  return out;
}

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

  function twoPlatformRoutes(): void {
    process.env.SB_PLATFORM_API_KEY = 'sk-test-primary,sk-test-backup';
    process.env.SB_PLATFORM_BASE_URL = 'https://primary.example/v1,https://backup.example/v1';
  }

  function platformReq(over?: Partial<ChatRequest>): ChatRequest {
    return {
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-test-primary',
      baseUrl: 'https://primary.example/v1',
      messages: [{ role: 'user', content: '问' }],
      quota: { ownerId: 'u1', platform: true },
      ...over,
    };
  }

  it('★ 第一路 429 ⇒ 换第二路：发两发，第二发用第二路的 baseUrl 与 key', async () => {
    twoPlatformRoutes();
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).startsWith('https://primary.example/v1')) {
        return { ok: false, status: 429, text: async (): Promise<string> => 'rate limited' };
      }
      return anthSseResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const chunks = await collectAnth(new AnthropicAdapter().chat(platformReq()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://primary.example/v1/messages');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://backup.example/v1/messages');
    const init2 = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect((init2?.headers as Record<string, string> | undefined)?.['x-api-key']).toBe('sk-test-backup');
    expect(chunks.map((c) => c.content).join('')).toContain('好');
  });

  it('★ 两路都 500 ⇒ 发两发后抛出（不无限重试）', async () => {
    twoPlatformRoutes();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(collectAnth(new AnthropicAdapter().chat(platformReq()))).rejects.toThrow('500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('★ BYOK（platform=false）429 ⇒ 只发一发、不换路', async () => {
    twoPlatformRoutes();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: false, status: 429, text: async (): Promise<string> => 'rate limited' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      collectAnth(
        new AnthropicAdapter().chat(
          platformReq({ quota: { ownerId: 'u1', platform: false }, apiKey: 'sk-test-byok', baseUrl: 'https://byok.example/v1' }),
        ),
      ),
    ).rejects.toThrow('429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://byok.example/v1/messages');
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
    await expect(collectAnth(new AnthropicAdapter().chat(platformReq({ signal: ac.signal })))).rejects.toThrow(
      /abort/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('★ 流式中途出错**不换路**：已吐字节 ⇒ 原样抛、只发一发', async () => {
    twoPlatformRoutes();
    // 每次 fetch 现造一个流：第一次 read 吐一段正文，第二次 read 报错（真·流中途出错）。
    const fetchMock = vi.fn(async () => {
      const encoder = new TextEncoder();
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          n += 1;
          if (n === 1) c.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"text":"前"}}\n\n'));
          else c.error(new Error('mid-stream boom'));
        },
      });
      return { ok: true, status: 200, text: async (): Promise<string> => '', body };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(collectAnth(new AnthropicAdapter().chat(platformReq()))).rejects.toThrow('mid-stream boom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('★ 候选只有一路 ⇒ 与从前逐字相同：成功照常；429 也只发一发', async () => {
    process.env.SB_PLATFORM_API_KEY = 'sk-test-only';
    process.env.SB_PLATFORM_BASE_URL = 'https://only.example/v1';
    const req = platformReq({ apiKey: 'sk-test-only', baseUrl: 'https://only.example/v1' });

    const ok = vi.fn(async () => anthSseResponse());
    vi.stubGlobal('fetch', ok);
    const chunks = await collectAnth(new AnthropicAdapter().chat(req));
    expect(ok).toHaveBeenCalledTimes(1);
    expect(chunks.at(-1)?.done).toBe(true);

    resetUpstreamGates();
    const bad = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rl' }));
    vi.stubGlobal('fetch', bad);
    await expect(collectAnth(new AnthropicAdapter().chat(req))).rejects.toThrow('429');
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
