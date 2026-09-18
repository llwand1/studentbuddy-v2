/**
 * learning/term-recall — 词条检索（回答「哪些词条与这次提问相关」）。
 *
 * ★ **为什么从 `learning/terms.ts` 拆出来**（2026-09-18 v0.2.49 记忆联动 P1 批）：
 *   本批给 `countUsage` 接上提及流水后，那个文件涨到 **409 行**，触 AGENTS.md
 *   「server `.ts` ≤ 400 行」红线。照本仓既有规矩办——**拆文件，不拿"压注释"换行数**
 *   （注释里记的是**为什么这么写**，删掉后下一个人就不知道了，见 skill §2 兜底判据）。
 *
 * ★ **拆的判据**是「两块东西的**修改频率或增长方向**不同 → 拆」：
 *   · 本文件**只读**——它随「相关性怎么打分」而变（打分公式 / 分词 / 加权项）；
 *   · `terms.ts` **写库**——它随「AI 抽取什么、怎么归一与 upsert」而变。
 *   两类改动几乎不会同时发生，却一直被塞在同一个文件里互相挤行数预算。
 *   （同一判据的先例：`chat/system-prompt.ts` 的提示词文案 ↔ 编排逻辑分家。）
 *
 * ★ **依赖方向刻意单向**：本文件 → `terms.js`（只取 `TermRow` **类型**），
 *   而 `terms.ts` 把 `getRelevantTerms` **re-export** 出去。
 *   `import type` 在编译后会被擦除 ⇒ **运行时不成环**。
 *   （本仓 `domains.ts → tidy.ts → terms.ts` 那次也是靠"依赖单向"断的环。）
 */
import type { TermRow } from './terms.js';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/** 轻量分词：英文按单词/驼峰切，中文按连续片段。 */
function tokens(s: string): string[] {
  const en = s.match(/[A-Za-z][A-Za-z0-9]+/g) ?? [];
  const cn = s.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  return [...en, ...cn];
}

/**
 * 相关性打分：term 直接出现在 query 里权重最高；否则 query 词元与 term 互相包含加分。
 * 无直接匹配返回 0（不相关）；有匹配后加 AI 重要度（×0.8）与近期使用（×0.3）作排序权重。
 * 零依赖、无向量库。
 */
function score(query: string, row: TermRow): number {
  const q = query.toLowerCase();
  const t = row.term.toLowerCase();
  let s = 0;
  if (q.includes(t) || t.includes(q)) s += 2.0;
  else {
    for (const tk of tokens(q)) {
      if (tk.length >= 2 && (t.includes(tk.toLowerCase()) || tk.toLowerCase().includes(t))) {
        s += 0.5;
        break;
      }
    }
  }
  if (s <= 0) return 0; // 无直接匹配 → 不相关，不参与注入
  s += (row.importance ?? 0.5) * 0.8;
  if (row.last_used_at) s += 0.3; // 近期用过的小幅加权（学生刚学的内容更可能接着问）
  return s;
}

/**
 * 检索与 query 相关的 Top-K 词条（供对话注入）。
 * ★ v31（M2d-2）：`ownerId` 必填——`SELECT *` 拉的是**全表**，不带归属会把别人的词条
 *   一起打分排序，命中后**注入进本轮对话上下文**（比"列表页看到"更隐蔽的泄露：
 *   用户会以为那是 AI 自己联想到的）。
 */
export function getRelevantTerms(query: string, ownerId: string | null, limit = 15): TermRow[] {
  if (!query?.trim()) return [];
  const rows = getDb()
    .prepare('SELECT * FROM term_library WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as TermRow[];
  return rows
    .map((r) => ({ r, s: score(query, r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}
