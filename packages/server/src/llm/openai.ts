/**
 * llm/openai — OpenAI 兼容流式适配器。
 * port from v1: src/core/adapter/openai-compatible.ts（审查搬运，全部踩坑修复保留）：
 * AbortSignal 桥接（停止生成真断流）/ tool_calls 增量合并 / 多推理字段兼容 /
 * 脏 SSE 行容错 / assistant(tool_calls) 的 content 用空串而非 null（部分网关拒绝 null）。
 */
import type { ChatMessage, ChatRequest, ContentPart, LLMAdapter, ModelListRequest, TokenChunk, ToolCall } from './types.js';
import { getMaxOutputTokens } from './model-limits.js';

/**
 * content 可能已是多模态段数组（视觉调用传图）。openai 视觉 API 认 `image_url` part，
 * 与 OpenAI 多模态消息格式一致；纯文本主模型不会收到图片 part（蒸馏在 chat/vision.ts 完成）。
 */
function toOpenAIContent(content: string | ContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map((p: ContentPart) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: p.image_url.url } },
  );
}

/**
 * 内部强绑口径 `{type:'function', name}` → OpenAI 出站规范 `{type:'function', function:{name}}`。
 * 真机 500 实证（2026-09-17，grill-me 首用即炸）：OpenAI 严格按 spec 校验，
 * 简写 `{type:'function',name}` 会被拒——"Invalid tool choice, ... Please ensure
 * tool_choice follows the OpenAI spec"。此前误把简写当 OpenAI 口径原样透传。
 */
function toOpenAIToolChoice(
  tc: ChatRequest['toolChoice'],
): 'auto' | 'none' | { type: 'function'; function: { name: string } } {
  if (!tc || tc === 'auto' || tc === 'none') return tc ?? 'auto';
  return { type: 'function', function: { name: tc.name } };
}

function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((tc: ToolCall) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: toOpenAIContent(m.content) };
  });
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  type = 'openai' as const;

  async *chat(req: ChatRequest): AsyncIterable<TokenChunk> {
    // 一次性回答（v13，池中 AI 形态）：不发流式请求，等完整 JSON 回来整块吐出。
    // 等待期由前端「思考中」UI 覆盖（首 token 前的空窗）；中转池大量按非流式聚合转发，
    // 对它们逐字流式只是把残缺体验拉长，不如一次到位。
    if (req.streamMode === 'once') {
      yield* this.chatOnce(req);
      return;
    }
    const baseUrl = req.baseUrl || 'https://api.openai.com/v1';
    const url = `${baseUrl}/chat/completions`;

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
        messages: toOpenAIMessages(req.messages),
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? getMaxOutputTokens(req.model),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools;
        // v18.1：强绑工具（grill-me 必问）——出站前转 OpenAI 规范口径，默认仍是 'auto'
        body.tool_choice = toOpenAIToolChoice(req.toolChoice);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errText}`);
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
            const choice = parsed.choices?.[0];
            const deltaObj = choice?.delta || {};
            const delta = deltaObj.content || '';
            const reasoning =
              deltaObj.reasoning_content ||
              deltaObj.reasoning ||
              deltaObj.thinking ||
              (deltaObj.reasoning_details && deltaObj.reasoning_details.content) ||
              '';
            const finishReason = choice?.finish_reason || undefined;
            const usage = parsed.usage
              ? {
                  promptTokens: parsed.usage.prompt_tokens || 0,
                  completionTokens: parsed.usage.completion_tokens || 0,
                }
              : undefined;

            if (Array.isArray(deltaObj.tool_calls)) {
              for (const tc of deltaObj.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : toolAccum.size;
                const cur = toolAccum.get(idx) || { id: '', name: '', arguments: '' };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name = tc.function.name;
                if (tc.function?.arguments) cur.arguments += tc.function.arguments;
                toolAccum.set(idx, cur);
              }
            }

            const chunk: TokenChunk = { content: delta, done: !!finishReason, finishReason, reasoning, usage };
            if (finishReason && toolAccum.size > 0) {
              const toolCalls: ToolCall[] = [...toolAccum.values()]
                .filter((t) => t.name)
                .map((t, i) => ({
                  id: t.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
                  name: t.name,
                  arguments: t.arguments || '{}',
                }));
              if (toolCalls.length > 0) chunk.toolCalls = toolCalls;
            }
            yield chunk;
            if (finishReason) return;
          } catch {
            // 脏 SSE 行（断行/非法 JSON）跳过不崩（v1 容错语义）
          }
        }
      }
      yield { content: '', done: true };
    } finally {
      if (fallback) clearTimeout(fallback);
      if (req.signal) req.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * 一次性回答分支：与流式分支同源的 abort 桥接与 tool_calls 解析，
   * 差异仅在 body.stream=false、响应是一次完整 JSON（choices[0].message 而非 delta）。
   * reasoning 多字段兼容口径与流式分支一致（中转池字段名不统一是常态）。
   */
  private async *chatOnce(req: ChatRequest): AsyncIterable<TokenChunk> {
    const baseUrl = req.baseUrl || 'https://api.openai.com/v1';
    const url = `${baseUrl}/chat/completions`;

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
        messages: toOpenAIMessages(req.messages),
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens ?? getMaxOutputTokens(req.model),
        stream: false,
      };
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools;
        // v18.1：强绑工具（grill-me 必问）——出站前转 OpenAI 规范口径，默认仍是 'auto'
        body.tool_choice = toOpenAIToolChoice(req.toolChoice);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${req.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errText}`);
      }
      const parsed = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning_content?: string;
            reasoning?: string;
            thinking?: string;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = parsed.choices?.[0];
      const msg = choice?.message;
      const reasoning = msg?.reasoning_content || msg?.reasoning || msg?.thinking || '';
      if (reasoning) yield { content: '', done: false, reasoning };
      const toolCalls: ToolCall[] | undefined =
        msg?.tool_calls && msg.tool_calls.length > 0
          ? msg.tool_calls
              .filter((tc) => tc.function?.name)
              .map((tc, i) => ({
                id: tc.id || `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments || '{}',
              }))
          : undefined;
      yield {
        content: msg?.content || '',
        done: true,
        finishReason: choice?.finish_reason || 'stop',
        usage: parsed.usage
          ? {
              promptTokens: parsed.usage.prompt_tokens || 0,
              completionTokens: parsed.usage.completion_tokens || 0,
            }
          : undefined,
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } finally {
      if (fallback) clearTimeout(fallback);
      if (req.signal) req.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  async listModels(config?: ModelListRequest): Promise<string[]> {
    try {
      const baseUrl = config?.baseUrl || 'https://api.openai.com/v1';
      const apiKey = config?.apiKey || '';
      const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) return [];
      const modelsRes = (await response.json()) as { data?: { id: string }[] };
      return (modelsRes.data || []).map((m) => m.id);
    } catch {
      return [];
    }
  }
}
