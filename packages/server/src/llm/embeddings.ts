/**
 * llm/embeddings — 文本向量（embedding）的**能力探测 + 调用**（契约 WEB-RAG-SPEC §1 L3）。
 *
 * ── 为什么在这里、而不是塞进某个检索文件 ────────────────────────────────
 * 「有没有 embedding 端点」「拿哪把 key、打哪个地址」是**服务商层**的事（同 `platform-channel.ts`
 * 的职责划分）；检索层只该拿到一个「文本数组 → 向量数组」的黑盒。故本文件只暴露三件：
 * 目标解析、模型名、调用；检索侧的排序逻辑在 `search/rerank.ts`（纯函数、不认服务商）。
 *
 * ★★ **端点可用性至今未经真机验证，这是设计的既定前提，不是缺陷** ──────────────
 * `DOC-RAG-SPEC` §8.3 与 `WEB-RAG-SPEC` §7 都写着：它要真调服务商（花额度），
 * 不属「可在开发机上自行开跑」的验证。因此本文件的**默认姿势是失败安全**：
 * 任何一步不成立（非 openai 协议 / 没配 key / HTTP 非 2xx / 返回形状不对 / 超时 / 断网）
 * ⇒ 一律返回 `null`，由调用方**退回 BM25 序**（L2 = 保底），并在回灌里如实标注降级。
 * 换句话说：端点可用时白拿一次精排，不可用时行为与 L2 逐字相同——这正是用户定的
 * 「择优 + 降级 + 原方案保底」。
 *
 * ★ 复用 `explain` 角色的 provider 凭据（平台 env / BYOK 都已由 `routeRole` 解析好）：
 *   多数 OpenAI 兼容网关的 `/v1/embeddings` 与 chat 同源同 key。**不新开角色**——
 *   新角色要迁移 + 设置页 UI，而本能力是可选增强，不值当为它加一整套配置面。
 *   模型名单独由 env `SB_EMBED_MODEL` 给（向量模型与聊天模型不同池，同 `SB_IMAGE_MODEL` 的道理）。
 */
import type { UpstreamQuota } from './types.js';
import { routeRole } from './router.js';
import { acquireUpstream } from './upstream-gate.js';
import { combineSignals } from '../search/combine.js';
import { WEB_RAG_EMBED_TIMEOUT_MS } from '@sb/shared';

/**
 * 精排 embedding 的部署默认模型（`env > 常量`，同 `DEFAULT_IMAGE_MODEL` 的写法）。
 * ★ 这只是**兜底猜测**：自建/中转网关的向量模型名各不相同，线上应显式配 `SB_EMBED_MODEL`；
 *   猜错不报错、只降级（见文件头「失败安全」）。
 */
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

export function embedModelName(): string {
  return (process.env.SB_EMBED_MODEL ?? '').trim() || DEFAULT_EMBED_MODEL;
}

/** 一次 embedding 调用的目标（凭据 + 模型 + 配额归属）。 */
export interface EmbedTarget {
  apiKey: string;
  baseUrl: string;
  model: string;
  quota: UpstreamQuota;
}

/**
 * 解析 embedding 目标：**能不能做精排**的唯一判据。
 * 返回 `null` 的三种情形（都属"该降级"，不是错误）：
 *   ① 一个 provider 都没有 / `explain` 角色不可路由；
 *   ② 落点是 anthropic 协议 —— 它**没有** `/v1/embeddings` 端点，发出去必 404；
 *   ③ 凭据里没 key（平台免费通道未开通）——发出去必 401。
 * ★ 判在**发请求之前**：拿不到目标就不该白花一次往返（同 `image-gen.ts` 按 type 早退的理由）。
 */
export function resolveEmbedTarget(ownerId: string | null = null): EmbedTarget | null {
  const t = routeRole('explain', undefined, ownerId);
  if (!t) return null;
  if (t.type !== 'openai') return null; // ② anthropic 行没有 embedding 端点
  if (!t.apiKey) return null; // ③ 没 key
  return { apiKey: t.apiKey, baseUrl: t.baseUrl, model: embedModelName(), quota: t.quota };
}

/**
 * 批量取向量。**任何失败都返回 `null`**（调用方据此退回 BM25 序），不抛不改调用方控制流。
 *
 * 走 `acquireUpstream(..., 'background')`：这是一笔**上游开销**（平台出钱时受配额约束），
 * 且属"为下一轮备料"的后台性质（排队时给主链让路）——与 `purpose` 的既定语义一致。
 * ★ 输入先按 `WEB_RAG_RERANK_CHARS` 截（在调用方完成）：超长块可能整批被上游拒，
 *   一次拒 = 整轮精排降级，代价不对等。
 */
export async function embedTexts(
  texts: readonly string[],
  target: EmbedTarget,
  opts: { signal?: AbortSignal } = {},
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const url = `${target.baseUrl.replace(/\/+$/, '')}/embeddings`;
  let release: (() => void) | null = null;
  try {
    release = await acquireUpstream(target.baseUrl, 'background', opts.signal, target.quota);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` },
      body: JSON.stringify({ model: target.model, input: texts }),
      signal: combineSignals(opts.signal, WEB_RAG_EMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ embedding?: unknown; index?: unknown }> };
    const rows = data.data;
    if (!Array.isArray(rows) || rows.length !== texts.length) return null;
    const out: number[][] = new Array(texts.length);
    rows.forEach((r, i) => {
      const idx = typeof r.index === 'number' ? r.index : i;
      out[idx] = Array.isArray(r.embedding) ? (r.embedding as number[]) : [];
    });
    // 任一行为空/缺失 ⇒ 形状不对 ⇒ 整批作废（宁可不精排，也不要半个向量序）
    if (out.some((v) => !Array.isArray(v) || v.length === 0)) return null;
    return out;
  } catch {
    return null; // 超时 / 断网 / 上游非 JSON —— 全部按"该降级"处理
  } finally {
    if (release) release();
  }
}