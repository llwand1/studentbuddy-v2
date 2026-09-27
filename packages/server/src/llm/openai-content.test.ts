/**
 * llm/openai-content.test — 验证 OpenAI 适配器把多模态 content-part 正确转成
 * `image_url` 段（与 OpenAI 视觉消息格式一致）。主模型走这条；纯文本主模型收不到图片
 * part（蒸馏在 chat/vision.ts 完成）。mock fetch 抓出站 body 断言，无需真实 API。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { OpenAICompatibleAdapter } from './openai.js';
import type { ChatMessage } from './types.js';

describe('OpenAICompatibleAdapter 多模态 content-part', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('把 image_url part 原样写进出站 messages', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '描述这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ];

    let sentBody: { messages: unknown[] } | null = null;
    // @ts-expect-error 单测替换全局 fetch
    global.fetch = async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    };

    const adapter = new OpenAICompatibleAdapter();
    for await (const _ of adapter.chat({ model: 'm', apiKey: 'k', baseUrl: 'http://x/v1', messages, streamMode: 'once' })) {
      /* drain */
    }

    expect(sentBody).not.toBeNull();
    const parsed = sentBody as unknown as { messages: Array<{ content: unknown }> };
    expect(parsed.messages[0]?.content).toEqual([
      { type: 'text', text: '描述这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('纯文本 content 仍走字符串形态（向后兼容）', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '普通问题' }];
    let sentBody: { messages: Array<{ content: unknown }> } | null = null;
    // @ts-expect-error 单测替换全局 fetch
    global.fetch = async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200 },
      );
    };

    const adapter = new OpenAICompatibleAdapter();
    for await (const _ of adapter.chat({ model: 'm', apiKey: 'k', baseUrl: 'http://x/v1', messages, streamMode: 'once' })) {
      /* drain */
    }

    const parsed = sentBody as unknown as { messages: Array<{ content: unknown }> };
    expect(parsed.messages[0]?.content).toBe('普通问题');
  });
});
