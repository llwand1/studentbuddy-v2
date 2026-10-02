/**
 * llm/openai — OpenAI 兼容流式适配器。
 * port from v1: src/core/adapter/openai-compatible.ts（审查搬运，全部踩坑修复保留）：
 * AbortSignal 桥接（停止生成真断流）/ tool_calls 增量合并 / 多推理字段兼容 /
 * 脏 SSE 行容错 / assistant(tool_calls) 的 content 用空串而非 null（部分网关拒绝 null）。
 */
import type { ChatMessage, ChatRequest, ContentPart, LLMAdapter, ModelListRequest, TokenChunk, ToolCall } from './types.js';
import { getMaxOutputTokens } from './model-limits.js';
import { acquireUpstream } from './upstream-gate.js';
import type { PlatformRoute } from './platform-channel.js';
import {
  decideFailover,
  failoverRoutes,
  markFailover,
  runFailover,
  UpstreamHttpError,
} from './upstream-failover.js';
import { asUpstreamError, createUpstreamGuard, UPSTREAM_IDLE_MS, UPSTREAM_TOTAL_MS } from './upstream-timeout.js';

/** 未配 baseUrl 时的默认入口（与从前逐字一致）。 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

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
    // 候选线路：**平台行**取 `platformRoutes()`（按 env 顺序，第一路＝主力），BYOK/未带配额取单路
    // （用 routeRole 解析出的那一对）——单路时 `runFailover` 只跑一次，行为与从前逐字相同。
    const routes = failoverRoutes(req);
    const list: ReadonlyArray<PlatformRoute> =
      routes.length > 0 ? routes : [{ index: 0, apiKey: req.apiKey, baseUrl: req.baseUrl || DEFAULT_BASE_URL }];

    // 一次请求占一个槽（主链优先、后台让路）；★ 换路时**重新 acquire**（闸门按 baseUrl 分桶，
    // 换路就该走新桶），每次尝试各计一笔（取舍见 `upstream-failover.ts` 文件头）。
    // ★ 只在最外层 acquire 一次 —— 每次尝试内部转调 `chatOnce()`/`chatStream()` 是内部调用，
    //   它们**不再 acquire**（若也 acquire 就会「自己等自己」直接死锁）。
    yield* runFailover(list, {
      acquire: (route) => acquireUpstream(route.baseUrl, req.purpose ?? 'main', req.signal, req.quota),
      attempt: (route) => (req.streamMode === 'once' ? this.chatOnce(req, route) : this.chatStream(req, route)),
    });
  }

  /**
   * 流式分支：SSE 增量解析。
   * 等待兜底＝**空闲超时**（每收到一段数据重置计时）——上游有数据在流就不该被掐，
   * 只有「真挂起」才会被兜住。首字节之前同样计时（原实现在此处完全裸奔，见 upstream-timeout.ts）。
   * @param route 本次尝试的那一路（key/baseUrl **成对**；换路只换整对，绝不 key/base 错配）
   */
  private async *chatStream(req: ChatRequest, route: PlatformRoute): AsyncIterable<TokenChunk> {
    const url = `${route.baseUrl}/chat/completions`;

    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, external: req.signal, idleMs: UPSTREAM_IDLE_MS });

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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new UpstreamHttpError(response.status, `OpenAI API error ${response.status}: ${errText}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      const toolAccum = new Map<number, { id: string; name: string; arguments: string }>();

      while (true) {
        const { done, value } = await reader.read();
        // 拿到任何数据即重置空闲计时：上游有数据在流就不该被掐（长回答不受影响）
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
    } catch (err) {
      // 超时转成可读错误（裸 AbortError 会让用户看到「生成失败：This operation was aborted」）；
      // 非超时的原始错误原样透传，HTTP 4xx/5xx 的报文要保真。
      const converted = asUpstreamError(err, guard);
      // ★ 是否可换路：HTTP 按状态码、超时按网络错；**用户取消一律不换**（硬约束 ②）。
      //   标记随错误穿过 generator 边界，由外层 `runFailover` 决定要不要进下一路；
      //   ★ 流式已吐字节时外层会因 `yielded` 拦下（硬约束 ①）。
      throw markFailover(converted, decideFailover(err, { timedOut: guard.timedOut(), aborted: !!req.signal?.aborted }));
    } finally {
      guard.dispose();
    }
  }

  /**
   * 一次性回答分支：与流式分支同源的 abort 桥接与 tool_calls 解析，
   * 差异仅在 body.stream=false、响应是一次完整 JSON（choices[0].message 而非 delta）。
   * reasoning 多字段兼容口径与流式分支一致（中转池字段名不统一是常态）。
   */
  private async *chatOnce(req: ChatRequest, route: PlatformRoute): AsyncIterable<TokenChunk> {
    const url = `${route.baseUrl}/chat/completions`;

    // 一次性请求没有任何中间帧可等 ⇒ 只能用总时长超时（流式那套「空闲超时」在此无从触发）
    const controller = new AbortController();
    const guard = createUpstreamGuard({ controller, external: req.signal, totalMs: UPSTREAM_TOTAL_MS });

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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new UpstreamHttpError(response.status, `OpenAI API error ${response.status}: ${errText}`);
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
    } catch (err) {
      // 一次性分支：任何抛出都在**产出任何 chunk 之前**（fetch/解析阶段）⇒ 未吐字节，
      // 换路安全（外层 `runFailover` 的 `yielded` 仍为 false）。用户取消不换（硬约束 ②）。
      const converted = asUpstreamError(err, guard);
      throw markFailover(converted, decideFailover(err, { timedOut: guard.timedOut(), aborted: !!req.signal?.aborted }));
    } finally {
      guard.dispose();
    }
  }

  async listModels(config?: ModelListRequest): Promise<string[]> {
    try {
      const baseUrl = config?.baseUrl || DEFAULT_BASE_URL;
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
