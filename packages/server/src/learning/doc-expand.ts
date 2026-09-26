/**
 * learning/doc-expand — 长资料问答的「查询扩展」档（契约 DOC-RAG-SPEC §10）。
 *
 * **治的病**：学生用大白话提问，教材用术语落笔，两者词元对不上 ⇒ BM25 召不回答案块。
 * 实测（`tools/probes/doc-rag-bm25.mjs` 的「查询扩展档」，716k 字语料／chunk=800／现役 k=12）：
 * 改写型召回 **8/13 → 12/13**，回退 **0** 条，残余漏接 1 条（第 6 章）。
 * ★ 同表对照：把 k 从 12 加到 24，召回**仍是 8/13**（已饱和）——所以这不是调参能救的，
 *   也不是 embedding 独占的地盘。`DOC-RAG-SPEC` §8.3 那条"embedding 端点未实测"的账本批已销：
 *   实测 `/v1/embeddings` 在两条通道上都返 **503 `model_not_found`**，且 `/v1/models` 的 12 个模型
 *   全为 chat/image/video ⇒ **平台通道当前无向量可用**，向量路线要等服务商挂了渠道再谈。
 *
 * **为什么只做"拼一条查询"**：探针同时量了三变体合并（原话／拼查询／纯术语各检索一次取最高分），
 * 结果同为 12/13——多跑两次检索换不到任何增益，按简洁优先砍掉。
 * **为什么只在长资料分支生效**：短文档走整篇直塞（契约硬约束 1「默认档逐字等价现状」），
 * 给它做扩展等于平白多花一次模型往返。判据用 `MAX_DOC_CHARS`，与 `buildDocBlock` 同一真相源。
 * **失败一律回落原话**：扩展不出来最多退回今天的行为；让它把整轮回答搞失败是不可接受的代价。
 */
import type { RoutedTarget } from '../llm/router.js';
import { getMaxOutputTokens } from '../llm/model-limits.js';
import { getSessionDoc, MAX_DOC_CHARS } from './document.js';

/**
 * 扩展调用的挂钟上限。实测 13 次：最快 811ms、最慢 10.4s（n=13，**中位数未量**，见 §10.4 未验账）。
 * 取 2.5s 的口径是「宁可这一轮不扩展，也不让首字多等一个量级」，不是量出来的拐点——
 * 真要贴着拐点取值，得先把逐次延迟分布补上。
 */
export const DOC_EXPAND_TIMEOUT_MS = 2_500;

/** 术语串字数上限。实测 13 条落在 23–48 字，120 是「模型多嘴几句也塞得下」的余量。 */
export const DOC_EXPAND_MAX_TERMS_CHARS = 120;

/** 提示词：要的是检索词元，不是答案。★ 与本批金样本 `doc-rag-rewrites.json` 用的是同一段。 */
export const DOC_EXPAND_PROMPT =
  '你是中文检索查询扩展器。用户给你一句中学生用大白话提的物理或化学问题，' +
  '你要猜出中文教材原文在讲同一件事时最常用的术语与关键词（量名、定律名、公式名、仪器名、实验名），' +
  '用于关键词检索。只输出 6 到 10 个词，用中文顿号分隔，不要解释、不要回答问题本身、不要客套。';

export interface DocExpandOpts {
  /** 用户按「停止」时要掐断这一次调用 */
  signal?: AbortSignal;
  /** 生产走 `DOC_EXPAND_TIMEOUT_MS`；开这个口子是给单测一个不用真等 2.5s 的用法 */
  timeoutMs?: number;
}

/** 只需要路由结果的这四个字段（★ 不写死 `RoutedTarget` 是为了单测能塞假适配器） */
export type ExpandTarget = Pick<RoutedTarget, 'adapter' | 'model' | 'apiKey' | 'baseUrl'>;

/**
 * 长资料场景下把原话扩成「原话 + 教材术语」；其余场景**原样返回且不发任何模型调用**。
 *
 * 扩出来的串只喂给文档检索这一路（词条检索仍吃原话——本批只量了文档一路，
 * 拿没量过的结论去改另一路是白写的典型形状）。
 */
export async function expandDocQuery(
  query: string,
  target: ExpandTarget,
  sessionId: string,
  ownerId: string | null,
  opts: DocExpandOpts = {},
): Promise<string> {
  const raw = query.trim();
  if (!raw) return query;
  const doc = getSessionDoc(sessionId, ownerId);
  if (!doc || doc.text.length <= MAX_DOC_CHARS) return query;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DOC_EXPAND_TIMEOUT_MS);
  if (opts.signal?.aborted) return query;
  opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    let acc = '';
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages: [
        { role: 'system', content: DOC_EXPAND_PROMPT },
        { role: 'user', content: raw },
      ],
      temperature: 0.3,
      // ★ 刻意不写小 maxTokens：实测思考链模型会把小预算全花在 reasoning 上、content 返空串
      //   （本批 13 条里有 5 条这么死过），截断交给下面的字数闸兜。
      maxTokens: getMaxOutputTokens(target.model),
      streamMode: 'once',
      signal: controller.signal,
    })) {
      if (chunk.content) acc += chunk.content;
      if (chunk.done) break;
    }
    const terms = acc.replace(/\s+/g, ' ').trim().slice(0, DOC_EXPAND_MAX_TERMS_CHARS);
    if (!terms) return query;
    return `${raw} ${terms}`;
  } catch {
    return query; // 抛错／超时都走这里：本轮退回今天的行为
  } finally {
    clearTimeout(timer);
  }
}
