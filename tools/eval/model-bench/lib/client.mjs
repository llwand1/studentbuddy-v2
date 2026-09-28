/**
 * model-bench/lib/client —— 带计量的 OpenAI 兼容客户端(零依赖)。
 *
 * 它替掉了 run.mjs 里原来那个只返回文本的 `llm()`。差别只有一件事:**每一次调用都留下一份账**
 * —— 时延、首 token、token 用量、成本、重试、finish_reason。原来那版把 `data.usage` 直接丢了,
 * 于是「换个便宜模型划不划算」这个问题在本仓一直答不了。
 *
 * ── 两种模式 ──
 * 非流式(默认):一发一收,`latencyMs` ＝ 整包墙钟,`ttftMs` ＝ null(量不到,见 meter.mjs 纪律 ②)。
 * 流式(`--stream`):逐块读,`ttftMs` ＝ **第一块带 content 的 delta 到达的时刻**。
 *   ★ 为什么值得多写这一条路:产品是 SSE 逐字上屏的(docs/SSE-CONTRACT.md),用户等的是首字不是整包。
 *     一个 p50 慢 3s 但首 token 只要 0.4s 的模型,在产品里体感**更快**;非流式跑分看不见这件事。
 *   ★ 流式下顺带发 `stream_options: { include_usage: true }`:OpenAI 兼容端点认这个字段才会在
 *     最后一块回 usage。不发的话流式模式会整轮没有成本数据 —— 这个坑不写下来下次还会踩。
 *
 * ── 重试的账怎么记(meter.mjs 纪律 ①)──
 * `latencyMs` 只算**最后那次成功尝试**;退避睡掉的时间进 `retryWaitMs`;失败尝试自己烧掉的时间进
 * `wastedMs`。三个数分开,是因为「模型慢」要换模型、「被限流」要降并发,处置相反。
 * 原版 run.mjs 的退避是 4s→8s→16s→32s→60s,这里保持一字不改地搬过来(改重试策略不是本批的事)。
 */
import { costOf } from '../../lib/pricing.mjs';
import { estimateTokens, finishReasonFromBody, usageFromBody } from '../../lib/meter.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一次调用的完整账目(进 results JSON,逐例可查) */
function emptySample() {
  return {
    ok: false,
    latencyMs: null,
    ttftMs: null,
    retryWaitMs: 0,
    wastedMs: 0,
    attempts: 0,
    httpStatus: null,
    finishReason: null,
    usage: null,
    costUsd: null,
    priceVia: null,
    promptChars: 0,
    outputChars: 0,
    error: null,
  };
}

/**
 * 流式读取:一边拼文本一边掐首 token 的表。
 * @returns {{ text: string, ttftMs: number|null, rawTail: string }}
 *   `rawTail` 是原始 SSE 文本,交给 meter 抠 usage/finish_reason —— **不在这里解析第二遍**,
 *   口径只有 meter.mjs 一份(同 pricing 的理由)。
 */
async function readStream(res, startedAt) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let raw = '';
  let text = '';
  let ttftMs = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffered += chunk;
    // SSE 以空行分块;半截块留在 buffered 里等下一轮(不这样做会 JSON.parse 抛一地)
    const parts = buffered.split(/\r?\n\r?\n/);
    buffered = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const c = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (typeof c === 'string' && c.length > 0) {
            // ★ 首 token 的定义:**第一块非空 content**。空 delta(角色声明块、心跳)不算,
            //   算进去的话 ttft 会被压到 ~0,变成一个恒定的漂亮假数字。
            if (ttftMs == null) ttftMs = Date.now() - startedAt;
            text += c;
          }
        } catch {
          /* 心跳行/半截块:跳过 */
        }
      }
    }
  }
  return { text, ttftMs, rawTail: raw };
}

/**
 * 发一次 chat/completions,返回 { text, sample }。
 *
 * @param {object} cfg  { apiBase, apiKey, model, retries, stream, estimateTokens }
 * @param {string} prompt
 * @param {{ temperature?: number, maxTokens?: number }} opts
 */
export async function chat(cfg, prompt, opts = {}) {
  const { temperature = 0.3, maxTokens = 4096 } = opts;
  const sample = emptySample();
  sample.promptChars = prompt.length;
  const url = `${String(cfg.apiBase).replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: cfg.model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: maxTokens,
  };
  if (cfg.stream) {
    body.stream = true;
    // 不发这个字段,流式模式整轮拿不到 usage ⇒ 成本栏全空(见头注)
    body.stream_options = { include_usage: true };
  }

  let lastErr = null;
  const retries = Number.isFinite(cfg.retries) ? cfg.retries : 5;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000;
      sample.retryWaitMs += Math.round(wait);
      await sleep(wait);
    }
    sample.attempts += 1;
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      sample.wastedMs += Date.now() - startedAt;
      lastErr = new Error(`network: ${String(e?.message ?? e)}`);
      continue;
    }
    sample.httpStatus = res.status;
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      sample.wastedMs += Date.now() - startedAt;
      lastErr = new Error(`API ${res.status}: ${detail}`);
      // 429(限流)与 5xx(服务端抖动)值得重试;其余 4xx 是我们自己的请求有问题,重试只是浪费额度
      if (res.status === 429 || res.status >= 500) continue;
      sample.error = lastErr.message;
      throw lastErr;
    }

    let text = '';
    let rawBody = '';
    if (cfg.stream) {
      const r = await readStream(res, startedAt);
      text = r.text;
      rawBody = r.rawTail;
      sample.ttftMs = r.ttftMs;
    } else {
      rawBody = await res.text();
      try {
        text = JSON.parse(rawBody)?.choices?.[0]?.message?.content ?? '';
      } catch {
        text = '';
      }
    }
    sample.latencyMs = Date.now() - startedAt;

    if (typeof text !== 'string' || text === '') {
      // 200 却抽不出文本 —— 与评测台 `empty-recording` 同款防呆:这是**我们读坏了或上游形状变了**,
      // 不能当成「模型写了个空题组」记进质量分,更不能静默重试成功后假装无事发生。
      sample.wastedMs += sample.latencyMs;
      sample.latencyMs = null;
      lastErr = new Error('200 但抽不出 content(形状不符:检查 stream 开关与上游返回格式)');
      continue;
    }

    sample.ok = true;
    sample.outputChars = text.length;
    sample.finishReason = finishReasonFromBody(rawBody);
    let usage = usageFromBody(rawBody);
    if (!usage && cfg.estimateTokens) {
      // 纪律 ③:估算值单独标源,绝不冒充实测
      usage = {
        promptTokens: estimateTokens(prompt),
        completionTokens: estimateTokens(text),
        totalTokens: estimateTokens(prompt) + estimateTokens(text),
        reasoningTokens: null,
        cachedTokens: null,
        source: 'estimated',
      };
    }
    sample.usage = usage;
    const cost = costOf(cfg.model, usage);
    if (cost) {
      sample.costUsd = cost.usd;
      sample.priceVia = cost.price.via + (cost.price.stale ? '(过期)' : '');
    }
    return { text, sample };
  }

  sample.error = String(lastErr?.message ?? lastErr ?? '未知失败');
  throw Object.assign(lastErr ?? new Error(sample.error), { sample });
}

/** 假模型也要有账:验通路时时延/用量全为 null,报告里照样显示「—」而不是凭空的 0 */
export function fakeSample(prompt, text) {
  const s = emptySample();
  s.ok = true;
  s.attempts = 1;
  s.promptChars = prompt.length;
  s.outputChars = String(text ?? '').length;
  return s;
}
