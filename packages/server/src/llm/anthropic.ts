/**
 * llm/anthropic — Anthropic Messages API 流式适配器（原生 AI 形态）。
 * port from v1: src/core/adapter/anthropic.ts（审查搬运）：
 * system 拆分 / tool_use 增量合并 / tool→user(tool_result) 回灌格式 / AbortSignal 桥接 /
 * max_tokens 强制（Anthropic 缺失即 400）。
 * v13（对话体验升级）新增：
 * - 原生思考链：req.thinking 开启 extended thinking，thinking_delta 以 reasoning 增量吐出，
 *   思考块随 assistant 轮回灌（Anthropic 契约：thinking + tool 循环不回传思考块会 400）；
 * - listModels 走真实 /models 端点（此前是写死三个型号的桩）。
 */
import type { ChatRequest, ContentPart, LLMAdapter, ModelListRequest, TokenChunk, ToolCall } from './types.js';
import { getMaxOutputTokens } from './model-limits.js';
import { acquireUpstream } from './upstream-gate.js';
import { asUpstreamError, createUpstreamGuard, UPSTREAM_IDLE_MS } from './upstream-timeout.js';

/** 思考预算（tokens）：≥1024 是 Anthropic 硬下限；max_tokens 必须大于它 */
const THINKING_BUDGET_TOKENS = 4096;

export class AnthropicAdapter implements LLMAdapter {
  type = 'anthropic' as const;

  async *chat(req: ChatRequest): AsyncIterable<TokenChunk> {
    const baseUrl = req.baseUrl || 'https://api.anthropic.com/v1';
    const url = `${baseUrl}/messages`;
    // 并发闸门（2026-09-17）：一次请求占一个上游槽，主链优先、后台让路。
    // 排队期间被「停止」会在此抛错——此时尚未建任何请求资源，无需清理。
    const release = await acquireUpstream(baseUrl, req.purpose ?? 'main', req.signal);

    // B-001（bug-ledger）：system 段可能有多条——基础提示词 / 忆域词条段 / 文档模式资料段 / 表达偏好段。
    // 旧实现用 find() 只取第一条，第二条起在出站请求里凭空消失（openai 适配器全量透传故掩盖）。
    const systemBlocks = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const nonSystemMsgs = req.messages.filter((m) => m.role !== 'system');

    // 等待兜底＝空闲超时（每收到一段数据重置）：原生 AI 先流思考链、再流正文，
    // 两段之间的间隔也算「有数据在流」——只有真挂起才兜住（见 upstream-timeout.ts）。
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, external: req.signal, idleMs: UPSTREAM_IDLE_MS });

    try {
      const maxTokens = req.maxTokens ?? getMaxOutputTokens(req.model);
      const body: Record<string, unknown> = {
        model: req.model,
        messages: nonSystemMsgs.map((m) => {
          if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            return {
              role: 'assistant',
              content: [
                // 思考块回灌：thinking + tool 循环时 Anthropic 强制要求 assistant 轮
                // 带上它上一轮的思考块（缺了直接 400）。无 thinking 请求里 m.reasoning 恒 undefined。
                ...(req.thinking && m.reasoning ? [{ type: 'thinking' as const, thinking: m.reasoning }] : []),
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
          // 多模态段（v17 看图）：把 image_url dataURL 转成 Anthropic 的 base64 图片 block
          if (Array.isArray(m.content)) {
            return { role: m.role, content: m.content.map(partToAnthropic) };
          }
          return { role: m.role, content: m.content };
        }),
        system: systemBlocks.filter(Boolean).join('\n\n') || undefined,
        temperature: req.temperature ?? 0.7,
        max_tokens: req.thinking ? Math.max(maxTokens, THINKING_BUDGET_TOKENS + 8192) : maxTokens,
        stream: true,
      };
      if (req.thinking) {
        body.thinking = { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS };
        // Anthropic 契约：thinking 开启时 temperature 只允许 1（或干脆不传）——不传最稳
        delete body.temperature;
      }
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description || '',
          input_schema: t.function.parameters || { type: 'object', properties: {} },
        }));
        // v18：强绑工具（grill-me 必问）。**必须转换口径**——Anthropic 是 `{type:'tool',name}`，
        // 与 OpenAI 的 `{type:'function',name}` 不同名，原样透传会 400。不传时 Anthropic 默认即 auto。
        const tc = req.toolChoice;
        if (tc === 'auto') body.tool_choice = { type: 'auto' };
        else if (tc && tc !== 'none') body.tool_choice = { type: 'tool', name: tc.name };
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
        // 拿到任何数据即重置空闲计时（思考链增量与正文增量都算「有数据在流」）
        guard.touch();
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
            // 思考链增量（req.thinking 时）：与正文同一通道下发，flow 按 reasoning 累积落库
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta' && parsed.delta.thinking) {
              yield { content: '', done: false, reasoning: parsed.delta.thinking };
            }
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
    } catch (err) {
      throw asUpstreamError(err, guard);
    } finally {
      guard.dispose();
      release();
    }
  }

  async listModels(config?: ModelListRequest): Promise<string[]> {
    try {
      const baseUrl = config?.baseUrl || 'https://api.anthropic.com/v1';
      const response = await fetch(`${baseUrl}/models?limit=100`, {
        headers: {
          'x-api-key': config?.apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data?: Array<{ id?: string; display_name?: string }> };
      return (data.data ?? []).map((m) => m.id || '').filter(Boolean);
    } catch {
      return [];
    }
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

/**
 * content-part → Anthropic content block。
 * 视觉调用传的是 `data:image/<ext>;base64,...` 的 dataURL，Anthropic 要 base64 source 块
 * （media_type 认 image/png|jpeg|gif|webp，jpg 归一成 jpeg）。
 */
function partToAnthropic(p: ContentPart): Record<string, unknown> {
  if (p.type === 'text') return { type: 'text', text: p.text };
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(p.image_url.url);
  if (m) {
    const sub = m[1] === 'jpg' ? 'jpeg' : m[1];
    return { type: 'image', source: { type: 'base64', media_type: `image/${sub}`, data: m[2] } };
  }
  // 非 dataURL（罕见）退回 url source（Anthropic 远端图 beta）
  return { type: 'image', source: { type: 'url', url: p.image_url.url } };
}
