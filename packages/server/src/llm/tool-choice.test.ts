/**
 * llm/tool-choice.test — v18 `toolChoice` 强绑的**出站口径**（grill-me 模式的地基）。
 *
 * 为什么单独成文件：grill-me 的「每轮必出选择框」不是提示词求来的，是 `tool_choice` 强绑来的。
 * 一旦适配器把 `toolChoice` 丢掉、或出站口径没转对，整个模式会**静默退化**成
 * 「靠模型自觉」——那正是这个模式要消灭的东西，且在真机上表现为「偶尔不出卡」，最难查。
 * 出站口径（v18.1 实证修正）：内部统一 `{type:'function',name}`；
 * OpenAI 出站必须 `{type:'function',function:{name}}`（简写真机 500）、Anthropic 出站 `{type:'tool',name}`。
 *
 * 三件事必须钉死：① 强绑真的传到位；② 不传时仍是 `auto`（既有行为一字未改）；
 * ③ 没有工具可调时不带 `tool_choice`（避免服务端因参数矛盾报错）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { OpenAICompatibleAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import type { ChatMessage, ToolDefinition } from './types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: '讲讲二分查找' }];

const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: { name: 'ask_choice', description: '抛出方案选择框', parameters: { type: 'object', properties: {} } },
  },
];

/** OpenAI 系（streamMode 'once'）抓出站 body */
async function sendOpenAI(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sent: Record<string, unknown>[] = [];
  // @ts-expect-error 单测替换全局 fetch
  global.fetch = async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200 },
    );
  };
  const adapter = new OpenAICompatibleAdapter();
  for await (const _ of adapter.chat({
    model: 'm',
    apiKey: 'k',
    baseUrl: 'http://x/v1',
    messages: MESSAGES,
    streamMode: 'once',
    ...body,
  })) {
    /* drain */
  }
  return sent[0]!;
}

/** Anthropic 系（恒流式）抓出站 body */
async function sendAnthropic(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sent: Record<string, unknown>[] = [];
  // @ts-expect-error 单测替换全局 fetch
  global.fetch = async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    // Anthropic 适配器走 SSE 解析，给一个立刻收尾的最小流
    return new Response('data: [DONE]\n\n', { status: 200 });
  };
  const adapter = new AnthropicAdapter();
  for await (const _ of adapter.chat({
    model: 'm',
    apiKey: 'k',
    baseUrl: 'http://x/v1',
    messages: MESSAGES,
    ...body,
  })) {
    /* drain */
  }
  return sent[0]!;
}

describe('tool_choice 出站口径', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('OpenAI：强绑 ask_choice 转成规范口径 {type:function,function:{name}} 出站（v18.1）', async () => {
    // 真机 500 实证（2026-09-17）：OpenAI 严格按 spec 校验，简写 {type:'function',name} 会被拒
    const body = await sendOpenAI({ tools: TOOLS, toolChoice: { type: 'function', name: 'ask_choice' } });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'ask_choice' } });
  });

  it('OpenAI：不传 toolChoice 时仍是 auto（既有行为一字未改）', async () => {
    const body = await sendOpenAI({ tools: TOOLS });
    expect(body.tool_choice).toBe('auto');
  });

  it('OpenAI：没有工具可调时不下发 tool_choice（避免参数矛盾）', async () => {
    const body = await sendOpenAI({ tools: [], toolChoice: { type: 'function', name: 'ask_choice' } });
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('Anthropic：**口径转换**成 {type:tool,name}（原样透传 OpenAI 口径会 400）', async () => {
    const body = await sendAnthropic({ tools: TOOLS, toolChoice: { type: 'function', name: 'ask_choice' } });
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'ask_choice' });
  });

  it('Anthropic：不传时不带 tool_choice（API 默认即 auto）', async () => {
    const body = await sendAnthropic({ tools: TOOLS });
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('Anthropic：tools 被转成 input_schema 口径（与 tool_choice 同一分支，别只改一半）', async () => {
    const body = await sendAnthropic({ tools: TOOLS, toolChoice: { type: 'function', name: 'ask_choice' } });
    expect(body.tools).toEqual([
      { name: 'ask_choice', description: '抛出方案选择框', input_schema: { type: 'object', properties: {} } },
    ]);
  });
});
