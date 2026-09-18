/**
 * learning/tidy-plan — 词条库 AI 整理的**方案产出侧**（2026-09-18 M2d-2 拆出）。
 *
 * ★ **为什么单开一个文件**：`tidy.ts` 加归属后涨到 400+ 行触 server 红线。照仓规
 *   **拆文件、不压注释**——本文件与 `tidy.ts` 的接缝是「**产出并校验方案**」vs
 *   「**把方案落到库里**（事务）」，前者只读 + 调模型，后者全是写；两侧的关注点不重叠。
 *   与 `term-usage.ts`（从 `terms.ts` 拆出）、`domains.ts`（从 `terms.ts` 拆出）同手法。
 *
 * ★ 本文件**只读**（除了调 LLM）：`planTidy` 拉全库词条、`normalizeTidyPlan` 纯函数校验。
 *   任何写库动作都在 `tidy.ts` 的 `applyTidy` / `mergeTerms` / `renameDomain` 里。
 *
 * ★ 归属（M2d-2）：`planTidy(ownerId)` 两处都要——
 *   ① 拉词条的 `SELECT` 必须按 owner 过滤（否则把别人的词条发给模型，整理方案里会
 *      出现不属于本用户的 id，`normalizeTidyPlan` 虽然会因「id 不存在」丢簇，
 *      但**用户的词条内容已经泄露给了模型**）；
 *   ② `routeRole('explain', undefined, ownerId)` 决定**这次模型调用记在谁头上**（M2c 口径）。
 */
import type { TidyPlan, TidyCluster } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { routeRole } from '../llm/router.js';
import type { TermRow } from './terms.js';

const TIDY_PROTOCOL = `你是词条库整理引擎。给定学习者的全部词条（每行：id | 词条 | 领域 | 释义），输出整理方案，严格按以下 JSON 格式输出，外围包一对 [TIDY]...[/TIDY] 标记：
[TIDY]{"clusters":[{"keep":"保留词条的id","term":"主词条名（必须取簇内已有词条名）","domain":"归一后的领域","merge":["被并入词条的id"],"reason":"一句话合并理由"}],"domainRenames":{"旧领域":"新领域"}}[/TIDY]
规则：
1. clusters 只合并同一概念的不同写法：同义词、中英互译、大小写/单复数变体、缩写展开。不确定是否同一概念的绝不合并。
2. 每簇至少 2 个词条（keep + merge）；keep 取信息最全或最常用的那条。
3. domainRenames 把碎领域归到规范名（如 计算机/computer science 归 cs）；已有规范领域名不动；领域名小写、不超过 30 字符。
4. 无可合并的输出空 clusters；无领域可归一时省略 domainRenames 字段。
5. 除该 JSON 外不要输出任何其他文字。
6. 输出必须是**完整合法**的 JSON：严禁用省略号（... 或 …）省略任何簇或字段，有几个簇就完整写几个；reason 不超过 30 字；闭合标记必须严格是 [/TIDY]（不能写成 </TIDY>）。`;

/** 单次整理送审的词条上限（importance+usage 排序截断；超大概率用不到，防撑爆） */
const TIDY_MAX_TERMS = 1000;

/** 从 src 的 at 处抽一个括号配平的完整 {...} 对象（字符串内的括号/引号不参与配平）；无配平返回 null */
function balancedObject(src: string, at: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = at; i < src.length; i++) {
    const ch = src[i] ?? '';
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return null;
}

/** 解析出的簇对象 → TidyCluster（字段类型防线，整包/逐簇两条路共用） */
function toCluster(c: unknown): TidyCluster | null {
  const cl = c as Partial<TidyCluster>;
  if (typeof cl.keep !== 'string' || !cl.keep) return null;
  if (typeof cl.term !== 'string' || !cl.term) return null;
  if (!Array.isArray(cl.merge)) return null;
  return {
    keep: cl.keep,
    term: cl.term,
    domain: typeof cl.domain === 'string' ? cl.domain : '',
    merge: cl.merge.filter((x): x is string => typeof x === 'string'),
    reason: typeof cl.reason === 'string' ? cl.reason.slice(0, 100) : '',
  };
}

/**
 * 省略号/截断 salvage（2026-09-07 真机抓到的失败形态：模型把 JSON 写成 `...}` 偷懒省略、
 * 闭合标签写成 </TIDY>，整包 JSON 非法）。不赌整包能解析：逐个抽「括号配平且能 JSON.parse」
 * 的完整簇对象 + domainRenames 对象，残尾直接丢。完整簇一个不丢，残簇不硬编——
 * normalizeTidyPlan 落库前还会再校验一遍 id 真实性，双保险。
 */
function salvageTidy(src: string): TidyPlan | null {
  const clusters: TidyCluster[] = [];
  let scanFrom = 0;
  for (;;) {
    const keepAt = src.indexOf('"keep"', scanFrom);
    if (keepAt < 0) break;
    const objStart = src.lastIndexOf('{', keepAt);
    if (objStart < 0) break;
    const obj = balancedObject(src, objStart);
    if (obj) {
      try {
        const cl = toCluster(JSON.parse(obj));
        if (cl) {
          clusters.push(cl);
          scanFrom = objStart + obj.length;
          continue;
        }
      } catch {
        /* 残簇：跳过，继续找下一个 "keep" */
      }
    }
    scanFrom = keepAt + 1;
  }
  const domainRenames: Record<string, string> = {};
  const drAt = src.indexOf('"domainRenames"');
  if (drAt >= 0) {
    const objStart = src.indexOf('{', drAt);
    if (objStart >= 0) {
      const obj = balancedObject(src, objStart);
      if (obj) {
        try {
          const data = JSON.parse(obj) as Record<string, unknown>;
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === 'string' && v) domainRenames[k] = v;
          }
        } catch {
          /* 残表：放弃 domainRenames，簇照常 salvage */
        }
      }
    }
  }
  if (clusters.length === 0 && Object.keys(domainRenames).length === 0) return null;
  return { clusters, domainRenames };
}

/** 解析模型输出中的 [TIDY] JSON（容错：多行/围栏/前后杂质；失败返回 null 走降级） */
export function parseTidyBlock(text: string): TidyPlan | null {
  // 模型闭合标签写错成 </TIDY>（2026-09-07 真机抓到）→ 先归一成 [/TIDY] 再匹配
  const normalized = text.replace(/<\/\s*TIDY\s*>/g, '[/TIDY]');
  const m = normalized.match(/\[TIDY\]([\s\S]*?)\[\/TIDY\]/);
  let raw = m ? m[1] : '';
  if (!raw && normalized.includes('"clusters"')) raw = normalized;
  if (!raw) return null;
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const data = JSON.parse(objMatch[0]) as { clusters?: unknown; domainRenames?: unknown };
      const clusters: TidyCluster[] = [];
      for (const c of Array.isArray(data.clusters) ? data.clusters : []) {
        const cl = toCluster(c);
        if (cl) clusters.push(cl);
      }
      const domainRenames: Record<string, string> = {};
      if (data.domainRenames && typeof data.domainRenames === 'object') {
        for (const [k, v] of Object.entries(data.domainRenames as Record<string, unknown>)) {
          if (typeof v === 'string' && v) domainRenames[k] = v;
        }
      }
      return { clusters, domainRenames };
    } catch {
      /* 整包非法（省略号/截断）→ 走 salvage 逐簇抢救 */
    }
  }
  return salvageTidy(cleaned);
}

function normDomain(d: string | undefined, fallback: string): string {
  return (d ?? '').trim().toLowerCase().slice(0, 30) || fallback;
}

/**
 * 校验规范化（applyTidy 前置防线，契约 §6）：
 * 丢无效簇（id 不存在/簇不足 2 条/canonical 杜撰/id 被其他簇占用）；领域改名只保留
 * 真实存在的旧领域。LLM 输出不可信，落库前必须过这一道。
 *
 * ★ **不需要 ownerId**：`rows` 由调用方按 owner 取好传进来，本函数只对这批行做校验
 *   （`byId` / `existing` 都从 `rows` 现算）⇒ 归属在**取数那一步**已经定死，这里是纯函数。
 *   ★ 这条也让「漏传归属」无法在本函数里发生——**取数带归属**是唯一入口。
 */
export function normalizeTidyPlan(plan: TidyPlan, rows: TermRow[]): TidyPlan {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const used = new Set<string>();
  const clusters: TidyCluster[] = [];
  for (const c of plan.clusters ?? []) {
    const ids = [...new Set([c.keep, ...(c.merge ?? [])])].filter((x) => typeof x === 'string' && x);
    if (ids.length < 2) continue;
    if (ids.some((id) => !byId.has(id) || used.has(id))) continue;
    const members = ids.map((id) => byId.get(id)).filter((r): r is TermRow => r !== undefined);
    if (members.length !== ids.length) continue;
    const term = c.term.trim();
    if (!members.some((r) => r.term === term)) continue; // canonical 必须取簇内已有词条名
    for (const id of ids) used.add(id);
    clusters.push({
      keep: c.keep,
      term,
      domain: normDomain(c.domain, byId.get(c.keep)?.domain ?? 'general'),
      merge: (c.merge ?? []).filter((id) => id !== c.keep),
      reason: (c.reason ?? '').slice(0, 100),
    });
  }
  const existing = new Set(rows.map((r) => r.domain));
  const domainRenames: Record<string, string> = {};
  for (const [from, to] of Object.entries(plan.domainRenames ?? {})) {
    const f = from.trim().toLowerCase();
    const t = normDomain(to, '');
    if (!f || !t || f === t || !existing.has(f)) continue;
    domainRenames[f] = t;
  }
  return { clusters, domainRenames };
}

/** 最近一次 planTidy 失败原因（tidyTerms 重试后如实上报；2026-09-07 前 catch 吞错导致用户只见笼统失败） */
let lastPlanError = '';

/** 读最近一次失败原因。★ 拆文件后 `tidyTerms` 在 `tidy.ts`，只能经这个取数口拿到（不能 import 变量本身——ESM 的活绑定在跨文件后仍成立，但显式取数口更清楚） */
export function lastPlanErrorOf(): string {
  return lastPlanError;
}

/**
 * 拉**本用户的**词条发 LLM 产出整理方案；null=调用失败（降级），空方案=无需整理。
 * ★ 取数带归属（见文件头 ①）：漏了这条会把别人的词条发给模型。
 */
export async function planTidy(ownerId: string | null): Promise<TidyPlan | null> {
  const rows = getDb()
    .prepare(
      'SELECT * FROM term_library WHERE owner_id = ? ORDER BY importance DESC, usage_count DESC LIMIT ?',
    )
    .all(ownerForWrite(ownerId), TIDY_MAX_TERMS) as TermRow[];
  if (rows.length < 2) return { clusters: [], domainRenames: {} };
  // M2c：整理方案是一次 LLM 调用，归属取发起者（契约 §8.1.4）
  const target = routeRole('explain', undefined, ownerId); // 与词条抽取同角色；契约留扩展点：可拆独立 tidy 角色
  if (!target || !target.model) {
    lastPlanError = '未配置可用的模型 provider';
    return null;
  }
  const domains = [...new Set(rows.map((r) => r.domain))];
  const lines = rows.map((r) => `${r.id} | ${r.term} | ${r.domain} | ${r.definition.replace(/\s+/g, ' ').slice(0, 60)}`);
  const prompt = `${TIDY_PROTOCOL}\n\n现有领域：${domains.join('、')}\n\n全部词条：\n${lines.join('\n')}`;
  let acc = '';
  try {
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages: [{ role: 'user', content: prompt }],
    })) {
      acc += chunk.content;
      if (chunk.done) break;
    }
  } catch (e) {
    // 整理 prompt ≈15k 字，第三方网关（agnes 等）对它偶发秒抛/中途断流/429（2026-09-07 实测 5 连发 2 失败），
    // 原因必须留档上报而不是吞成 null——否则用户永远只看到笼统的"调用失败"。
    lastPlanError = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
    return null;
  }
  const plan = parseTidyBlock(acc);
  if (!plan) {
    lastPlanError = acc.trim() ? `模型输出不含有效 [TIDY] 方案（输出 ${acc.length} 字）` : '模型返回空输出';
    return null;
  }
  return normalizeTidyPlan(plan, rows);
}
