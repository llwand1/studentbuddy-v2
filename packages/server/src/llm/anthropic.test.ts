/**
 * llm/anthropic 出站请求体回归。
 * 两件事：① bug-ledger B-001——多条 system 必须全部下发（旧实现只发第一条）；
 * ② test-plan §6 首笔记的结构性欠账——适配器层对「发给模型的 body」零断言。
 * 手法：桩掉 global fetch，把 init.body 解出来逐字段钉死，不打真网络。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AnthropicAdapter } from './anthropic.js';
import type { ChatMessage, ToolDefinition } from './types.js';

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

describe('system 段合并（B-001 回归）', () => {
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
