/**
 * learning/term-extract — 词条**抽取**（材料 → 词条列表：LLM 协议 + 解析 + 归一）。
 *
 * ★ **为什么从 `learning/terms.ts` 拆出来**（2026-09-18 v28 复习范围批）：
 *   本批给词条加复习范围（`TermRow.review_enabled` + 列表查询多一个 JOIN）后，那个文件
 *   涨到 **401 行**，触 AGENTS.md「server `.ts` ≤ 400 行」红线。照本仓既有规矩办——
 *   **拆文件，不拿"压注释"换行数**（注释记的是**为什么这么写**，删掉下一个人就不知道了）。
 *
 * ★ **拆的判据**是「两块东西的**修改频率或增长方向**不同 → 拆」：
 *   · 本文件随「**AI 抽取什么、怎么解析**」而变（提示词 / JSON 协议 / 模型路由 / 容错阶梯）；
 *   · `terms.ts` 随「**怎么存、怎么查**」而变（upsert 语义 / 防再分裂索引 / 列表与范围过滤）。
 *   两类改动几乎不会同时发生，却一直被塞在同一个文件里互相挤行数预算。
 *   （同一判据的先例：`term-recall.ts` 拆"只读检索"、`chat/system-prompt.ts` 拆提示词文案。）
 *
 * ★ **依赖方向刻意单向**：本文件只依赖 `storage/db` 与 `llm/router`，**不反向 import
 *   `terms.ts`**；`terms.ts` 反过来 import 本文件的 `normalizeTerms`（入库前要归一），
 *   并把四个公开名 re-export 出去 ⇒ **调用方 import 路径零改动**（同 `term-recall.ts` 手法）。
 */
import { getDb } from '../storage/db.js';
import { routeRole } from '../llm/router.js';

/** 待入库的一条词条（抽取产物 / 手动添加的入参，两条路共用同一形状） */
export interface TermItem {
  id?: string;
  term: string;
  definition: string;
  domain?: string;
  sourceSessionId?: string | null;
  importance?: number;
}

/** 抽取提示词（[TERMS] JSON 协议）。导出是给契约测试与将来换抽取角色时复用 */
export const TERMS_PROTOCOL = `你是术语抽取引擎。从给定材料中抽取学习者应当记住的重要术语（英语单词 / 专业术语），严格按以下 JSON 格式输出，输出外围包一对 [TERMS]...[/TERMS] 标记：
[TERMS]{"terms":[{"term":"术语或单词","definition":"精炼中文释义（英语单词可含词性/例句要点；专业术语给准确定义）","domain":"english 或学科名如 math/cs/生物/化学 等，无法归类用 general","importance":0到1的数值，越核心越高}]}[/TERMS]
规则：只抽对学习有价值的术语，通常 3-8 条；term 用原文（英文单词保留英文，中文术语用中文）；definition 精炼准确；除该 JSON 外不要输出任何其他文字。`;

/** 解析模型输出中的 [TERMS] JSON（容错：多行/围栏/前后杂质；失败返回 [] 走降级） */
export function parseTermsBlock(text: string): TermItem[] {
  const m = text.match(/\[TERMS\]([\s\S]*?)\[\/TERMS\]/);
  let raw = m ? m[1] : '';
  if (!raw && text.includes('"terms"')) raw = text;
  if (!raw) return [];
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!objMatch) return [];
  try {
    const data = JSON.parse(objMatch[0]) as { terms?: TermItem[] };
    return normalizeTerms(data.terms ?? []);
  } catch {
    return [];
  }
}

/** 校验规范化：丢弃无 term/definition 的条目；importance 钳到 0-1。 */
export function normalizeTerms(items: TermItem[]): TermItem[] {
  const out: TermItem[] = [];
  for (const t of items ?? []) {
    const term = t.term?.trim();
    const definition = t.definition?.trim();
    if (!term || !definition) continue;
    const importance = Number(t.importance);
    out.push({
      term,
      definition,
      domain: (t.domain ?? '').trim().toLowerCase().slice(0, 30) || 'general',
      importance: Number.isFinite(importance) ? Math.min(1, Math.max(0, importance)) : 0.5,
    });
  }
  return out;
}

/**
 * 一键抽取（材料 → 词条列表）；返回 [] 表示失败（降级由调用方处理）。
 *
 * ★ M2c：`ownerId` 是这次 LLM 调用的归属（契约 TENANCY-SPEC §8.1.4）。
 *   本函数有**两个**入口：HTTP（`routes/terms.ts` 的「存入记忆」/文档模式）与
 *   **响应后 fire-and-forget**（`chat/flow.ts` 的 `void extractTerms(...)`）——
 *   后者的 ownerId 只能靠显式下传，正是 §8.1.4 选"显式穿透而非 ALS"的直接理由之一。
 *   ⚠️ 词条**落库**的归属（`term_library`）是 M2d（§8.2），本批只管"模型记在谁头上"。
 */
export async function extractTerms(material: string, ownerId?: string | null): Promise<TermItem[]> {
  if (!material?.trim()) return [];
  const target = routeRole('explain', undefined, ownerId); // 抽取复用讲解角色模型；契约留扩展点：可拆独立 extractor 角色
  if (!target || !target.model) return [];
  let acc = '';
  // 防领域碎裂：注入已有领域 top-12，引导新词条优先归入既有领域（TERM-TIDY-SPEC §7.2）。
  // 领域清单**直查 `term_domain`**，不 import `learning/domains.ts`——那会成
  // `terms → domains → tidy → terms` 环（见 domains.ts 头注释的依赖方向说明）。
  // 排序仍按词条数降序（与 v19 前 `domainStats().domains.slice(0,12)` 的口径一致）；
  // 空领域（count=0）排在最末，只在领域总数不足 12 时才进引导——它没有词条作例证，引导力弱。
  const known = (
    getDb()
      .prepare(
        `SELECT d.name AS name FROM term_domain d
           LEFT JOIN term_library t ON t.domain = d.name
          GROUP BY d.name ORDER BY COUNT(t.id) DESC, d.name ASC LIMIT 12`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const guide = known.length > 0 ? `\n已有领域（优先复用，确实不属于再新建）：${known.join('、')}` : '';
  const prompt = `${TERMS_PROTOCOL}${guide}\n\n材料：\n${material.slice(0, 30000)}`;
  try {
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages: [{ role: 'user', content: prompt }],
      // 后台任务（对话已结束才跑，用户在等的是下一轮）：排队时给主链让路
      purpose: 'background',
    })) {
      acc += chunk.content;
      if (chunk.done) break;
    }
  } catch {
    return [];
  }
  return parseTermsBlock(acc);
}
