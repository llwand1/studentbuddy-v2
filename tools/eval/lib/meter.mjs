/**
 * tools/eval/lib/meter —— 延迟与用量的**纯计量口径**（零依赖、零网络、零状态）。
 *
 * 为什么是纯函数：两套评测台取数的姿势完全不同 ——
 *   `tools/eval/`（评测台）走产品自己的调用链，原始响应落在**录制代理**的 `responseBody` 里；
 *   `tools/eval/model-bench/`（横评台）自己发 HTTP，响应在手上。
 * 两边共同的只有「一段 OpenAI 兼容的响应体 → 用了多少 token」这一步。把它单拎出来做成纯函数，
 * 就能让两边的成本口径**不可能漂移**，也让口径本身可以被 `--selftest` 用假响应体钉住。
 *
 * ══ 五条计量纪律（每条都对应一种会读出假数字的错法）══
 *
 * ① **时延要拆三个数，不许合成一个。**
 *    `latencyMs`＝最后一次**成功**尝试的墙钟；`retryWaitMs`＝指数退避睡掉的时间；
 *    `wastedMs`＝失败尝试本身烧掉的时间。合成一个数之后，「这模型慢」与「这家在限流我」
 *    就再也分不开了 —— 而这两件事的处置完全相反（换模型 vs 降并发）。
 *
 * ② **TTFT 只有流式下才存在。** 非流式恒为 `null`，渲染成 `—（非流式）`。
 *    产品是 SSE 逐字上屏的（`docs/SSE-CONTRACT.md`），用户感知的是首 token 而不是整包；
 *    但非流式跑分**物理上量不到**这个数，写 0 就是造假。
 *
 * ③ **token 分四个来源，报告里必须看得见是哪一档**：
 *    `api`（响应体里的 usage）＞ `stream`（stream_options.include_usage 回的 usage）
 *    ＞ `estimated`（字符估算，仅 `--estimate-tokens` 时才启用）＞ `none`。
 *    估算值绝不混进「实测」那一栏 —— 混了之后，成本对比就变成了两个估算器的对比。
 *
 * ④ **并发会污染时延。** p50/p95 在 `--concurrency 3` 下测出来的不是串行时延，
 *    聚合结果因此固定带 `concurrency` 字段，渲染侧并发 >1 时必须打 ⚠。想要可比的时延就 `--serial`。
 *
 * ⑤ **隐藏思考 token 单列。** 推理型模型的 `completion_tokens_details.reasoning_tokens`
 *    要付钱、要占输出窗口，却不出现在正文里。本仓已经被它咬过一次（`run.mjs` 的 verify 注释：
 *    「agnes/gemini 系有隐藏思考 token，给 16 会把答案截成空串」）。不单列就会读成「输出很短却很贵」。
 */

// ────────────────────────────────── token 估算 ──────────────────────────────────

/**
 * 字符级 token 估算（**只在 provider 不回 usage 且显式开了 --estimate-tokens 时使用**）。
 *
 * 口径：CJK 与全角标点按 1 token/字，其余按 1 token/4 字符 —— 这是公开 tokenizer 在中英混排上的
 * 常见量级，误差 ±25% 属正常。它的用途只有一个：给没有 usage 的自建端点一个**量级**，
 * 好让「这条链路大概烧多少钱」不至于完全空白。任何进了这条路的数都带 `estimated` 标。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
  const rest = [...s].length - cjk;
  return Math.ceil(cjk + rest / 4);
}

// ──────────────────────────────── 响应体 → 用量 ────────────────────────────────

/** OpenAI 兼容的 usage 对象 → 本仓口径（字段缺失一律 null，不补 0） */
function normalizeUsage(u, source) {
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (Number.isFinite(v) ? Number(v) : null);
  const prompt = num(u.prompt_tokens) ?? num(u.input_tokens);
  const completion = num(u.completion_tokens) ?? num(u.output_tokens);
  if (prompt == null && completion == null) return null;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: num(u.total_tokens) ?? (prompt != null && completion != null ? prompt + completion : null),
    // 纪律 ⑤：隐藏思考 token 单列（付钱、占窗口、不进正文）
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens) ?? num(u.output_tokens_details?.reasoning_tokens),
    cachedTokens: num(u.prompt_tokens_details?.cached_tokens),
    source,
  };
}

/**
 * 从一段 OpenAI 兼容响应体里抠出 usage。
 *
 * 三种形状都得吃（与 `recorder.mts` 的 `recordedText` 同款覆盖面，理由也同款：
 * 本仓 openai 适配器**恒发 `stream: true`**，只兜非流式就会恒为 null）：
 *   ① 非流式 JSON：顶层 `usage`；
 *   ② SSE：某一块（通常是最后一块，`stream_options.include_usage` 开了才有）带 `usage`；
 *   ③ 都没有：返回 null —— 由调用侧决定是记 `none` 还是走估算。
 */
export function usageFromBody(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  if (!text.trim()) return null;
  try {
    const body = JSON.parse(text);
    const hit = normalizeUsage(body?.usage, 'api');
    if (hit) return hit;
  } catch {
    /* 不是整块 JSON ⇒ 往下当 SSE 试 */
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const hit = normalizeUsage(JSON.parse(payload)?.usage, 'stream');
      if (hit) return hit;
    } catch {
      /* 心跳行/半截块：跳过 */
    }
  }
  return null;
}

/** finish_reason（非流式与 SSE 两种形状）—— 撞输出上限是成本与质量的共同解释项 */
export function finishReasonFromBody(raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  if (!text.trim()) return null;
  try {
    const r = JSON.parse(text)?.choices?.[0]?.finish_reason;
    if (typeof r === 'string') return r;
  } catch {
    /* 往下当 SSE 试 */
  }
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const r = JSON.parse(payload)?.choices?.[0]?.finish_reason;
      if (typeof r === 'string') last = r;
    } catch {
      /* 跳过 */
    }
  }
  return last;
}

/**
 * 从**实际发出去的请求体**里读采样参数。
 *
 * ★ 这是「报告头七项」里温度与随机种子的来源，也是它们唯一可信的来源：
 *   评测台一行不改产品参数（`runners/quiz.mts` 头注），所以温度是多少**只有请求体知道**。
 *   写在文档里靠人抄 —— 那正是 `docs/eval/quiz.md` §1 当初缺这四项的原因。
 *   产品不传 `seed` 时这里返回 null，报告照实写「未设种子」，不编一个出来。
 */
export function samplingFromRequest(raw) {
  let body = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== 'object') return null;
  const num = (v) => (Number.isFinite(v) ? Number(v) : null);
  return {
    model: typeof body.model === 'string' ? body.model : null,
    temperature: num(body.temperature),
    topP: num(body.top_p),
    maxTokens: num(body.max_tokens) ?? num(body.max_completion_tokens),
    seed: num(body.seed),
    stream: body.stream === true,
  };
}

// ──────────────────────────────── 聚合 ────────────────────────────────

/**
 * 百分位（**最近秩法**，样本已排序）。
 * 刻意不做插值：评测样本常是 15～40 个，插值出来的 p95 是两个真实观测之间一个谁也没测到的数，
 * 而「最近秩」至少保证 p95 是**真的发生过的那一次**，可以回去翻它的原文。
 */
export function pctl(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

/**
 * 一组样本 → 时延画像。
 * @param {Array<{latencyMs?:number|null, ttftMs?:number|null}>} samples
 * @param {{ concurrency?: number }} opts 并发数照实带进结果（纪律 ④）
 */
export function summarizeLatency(samples, opts = {}) {
  const lat = samples.map((s) => s?.latencyMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const ttft = samples.map((s) => s?.ttftMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const pack = (xs) =>
    xs.length === 0
      ? null
      : {
          n: xs.length,
          p50: pctl(xs, 50),
          p90: pctl(xs, 90),
          p95: pctl(xs, 95),
          max: xs[xs.length - 1],
          mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
        };
  return {
    concurrency: opts.concurrency ?? null,
    total: pack(lat),
    // null ＝ 本轮非流式，**量不到**；不是 0
    ttft: pack(ttft),
  };
}

/**
 * 一组样本 → 用量与成本画像。
 *
 * 分母纪律：`costedCases` 是**真的算出了钱**的样本数。报告里成本必须与它一起出现，
 * 否则「$0.012」会被读成全 40 例的总账，而实际上可能只有 3 例有 usage。
 *
 * @param {Array<{usage?:object|null, costUsd?:number|null, promptChars?:number, outputChars?:number}>} samples
 */
export function summarizeCost(samples) {
  const out = {
    cases: samples.length,
    // token 来源分档（纪律 ③）——四个数加起来必须等于 cases，否则口径漏了一种形状
    bySource: { api: 0, stream: 0, estimated: 0, none: 0 },
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    tokenCases: 0,
    costUsd: 0,
    costedCases: 0,
    promptChars: 0,
    outputChars: 0,
  };
  for (const s of samples) {
    const u = s?.usage ?? null;
    const src = u?.source ?? 'none';
    out.bySource[src] = (out.bySource[src] ?? 0) + 1;
    out.promptChars += s?.promptChars ?? 0;
    out.outputChars += s?.outputChars ?? 0;
    if (u) {
      out.tokenCases += 1;
      out.promptTokens += u.promptTokens ?? 0;
      out.completionTokens += u.completionTokens ?? 0;
      out.reasoningTokens += u.reasoningTokens ?? 0;
      out.cachedTokens += u.cachedTokens ?? 0;
    }
    if (Number.isFinite(s?.costUsd)) {
      out.costUsd += s.costUsd;
      out.costedCases += 1;
    }
  }
  return out;
}

/**
 * 决策指标：**每分成本**（跑完一个套件、每拿到 1 分质量分要花多少钱）。
 *
 * 为什么是这个数而不是「总成本」：换模型的问题从来不是「哪个便宜」，而是
 * 「便宜的那个掉了多少分、这些分值不值省下来的钱」。总成本单看会选出一个又便宜又不能用的模型；
 * 质量单看会选出一个用不起的。两者相除才是可以拿去拍板的数。
 *
 * 分母保护：质量分 ≤ 0 时返回 null（渲染成 `—`）—— 一个 0 分的模型再便宜也没有「每分成本」可言。
 */
export function costPerPoint(costUsd, score0to1) {
  if (!Number.isFinite(costUsd) || !Number.isFinite(score0to1) || score0to1 <= 0) return null;
  return costUsd / (score0to1 * 100);
}

/** 毫秒 → 人读（报告里 12564ms 不如 12.6s 好比大小） */
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 时延画像 → 一行文字；量不到就说量不到 */
export function fmtLatency(pack) {
  if (!pack) return '—（无样本）';
  return `p50 ${fmtMs(pack.p50)}／p95 ${fmtMs(pack.p95)}／max ${fmtMs(pack.max)}`;
}
