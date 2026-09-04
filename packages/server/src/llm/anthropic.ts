/**
 * llm/anthropic — Anthropic Messages API 流式适配器。
 * port from v1: src/core/adapter/anthropic.ts（审查搬运）：
 * system 拆分 / tool_use 增量合并 / tool→user(tool_result) 回灌格式 / AbortSignal 桥接 /
 * max_tokens 强制（Anthropic 缺失即 400）。
 */
import type { ChatRequest, LLMAdapter, ModelListRequest, TokenChunk, ToolCall } from './types.js';
import { getMaxOutputTokens } from './model-limits.js';

export class AnthropicAdapter implements LLMAdapter {
  type = 'anthropic' as const;

  async *chat(req: ChatRequest): AsyncIterable<TokenChunk> {
    const baseUrl = req.baseUrl || 'https://api.anthropic.com/v1';
    const url = `${baseUrl}/messages`;

    // B-001（bug-ledger）：system 段可能有多条——基础提示词 / 忆域词条段 / 文档模式资料段 / 表达偏好段。
    // 旧实现用 find() 只取第一条，第二条起在出站请求里凭空消失（openai 适配器全量透传故掩盖）。
    const systemBlocks = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const nonSystemMsgs = req.messages.filter((m) => m.role !== 'system');

    const controller = new AbortController();
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const onExternalAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', onExternalAbort, { once: true });
    } else {
      fallback = setTimeout(() => controller.abort(), 120_000);
    }

    try {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: nonSystemMsgs.map((m) => {
          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            return {
              role: 'assistant',
              content: [
                ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
                ...m.toolCalls.map((tc: ToolCall) => ({
                  type: 'tool_use' as const,
                  id: tc.id,
                  name: tc.name,
                  input: safeParse(tc.arguments),
                })),
              ],
            };
          }
          if (m.role === 'tool') {
            return {
              role: 'user',
              content: [{ type: 'tool_result' as const, tool_use_id: m.toolCallId, content: m.content }],
            };
          }
          return { role: m.role, content: m.content };
        }),
        system: systemBlocks.filter(Boolean).join('\n\n') || undefined,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? getMaxOutputTokens(req.model),
        stream: true,
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description || '',
          input_schema: t.function.parameters || { type: 'object', properties: {} },
        }));
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': req.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errText}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      const toolAccum = new Map<number, { id: string; name: string; arguments: string }>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              yield { content: parsed.delta.text, done: false };
            }
            if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
              const idx = typeof parsed.index === 'number' ? parsed.index : toolAccum.size;
              toolAccum.set(idx, {
                id: parsed.content_block.id || '',
                name: parsed.content_block.name || '',
                arguments: '',
              });
            }
            if (
              parsed.type === 'content_block_delta' &&
              parsed.delta?.type === 'input_json_delta' &&
              typeof parsed.delta.partial_json === 'string'
            ) {
              const idx = typeof parsed.index === 'number' ? parsed.index : toolAccum.size - 1;
              const cur = toolAccum.get(idx);
              if (cur) cur.arguments += parsed.delta.partial_json;
            }
            if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
              const chunk: TokenChunk = { content: '', done: true, finishReason: parsed.delta.stop_reason };
              if (parsed.delta.stop_reason === 'tool_use' && toolAccum.size > 0) {
                const toolCalls: ToolCall[] = [...toolAccum.values()]
                  .filter((t) => t.name)
                  .map((t, i) => ({
                    id: t.id || `toolu_${i}_${Date.now().toString(36)}`,
                    name: t.name,
                    arguments: t.arguments || '{}',
                  }));
                if (toolCalls.length > 0) chunk.toolCalls = toolCalls;
              }
              yield chunk;
              return;
            }
          } catch {
            // 脏行容错（同 openai 适配器）
          }
        }
      }
      yield { content: '', done: true };
    } finally {
      if (fallback) clearTimeout(fallback);
      if (req.signal) req.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  async listModels(_config?: ModelListRequest): Promise<string[]> {
    return ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'];
  }
}

function safeParse(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
