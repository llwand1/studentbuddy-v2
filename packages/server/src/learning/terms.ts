/**
 * learning/terms — AI 自动词条库（忆域 v2，2026-09-01 契约）。
 * 取代旧「手动词条 + SRS 翻卡」（memorize/srs 已废弃）。
 *
 * 机制：
 *  1. 抽取：每轮对话/手动触发 → extractTerms 调 LLM 从材料中抽「重要术语」
 *     （英语单词 / 专业术语），[TERMS] JSON 协议，失败降级不崩（ADR-4）。
 *     ★ **已拆到 `term-extract.ts`**（v28 行数红线，见文件末的 re-export 注释）。
 *  2. 入库：saveTerms 先查防再分裂索引——同词同域（大小写不敏感）或命中已有
 *     词条的别名（跨域，AI 整理时判定的同一概念）→ 并入该行不新建；其余走
 *     UNIQUE(term, domain) upsert（同词条取更高 importance、更新释义）。
 *  3. 使用：getRelevantTerms 按关键词重叠度 + 重要度 + 近期使用排序，注入后续对话
 *     （flow.ts 软性提示 AI 优先使用，保持自然）。★ **已拆到 `term-recall.ts`**。
 *  4. 计数：countUsage 扫描已完成回复命中词条（term + 别名，大小写不敏感，
 *     英文词按边界匹配防子串误报），累积 usage_count（反馈「记住了多少」）。
 *  5. 范围：v28 起复习改成**选择式**——`review_enabled` 覆盖位 + 领域开关，
 *     有效范围由 `term-review.ts` 现算（契约 EBBINGHAUS-SPEC §9）。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { publishEvent } from '../events/bus.js';
import { recordMentions } from './mention.js';
// 入库前要归一（抽取侧的 `normalizeTerms`）；类型 `TermItem` 同源，避免两处各写一份形状。
import { normalizeTerms, type TermItem } from './term-extract.js';
// ★ v28 复习范围：有效范围的**取值与连接**都向 `term-review.ts` 要（那里是唯一实现），
//   本文件只负责把它挂进列表查询。依赖方向安全：`term-review.ts` 不反向依赖本文件，
//   故不成环（对比 `terms → domains → tidy → terms` 那条必须避开的环，见 domains.ts 头注释）。
import { SCOPE_FLAG, SCOPE_JOIN } from './term-review.js';

export interface TermRow {
  id: string;
  term: string;
  definition: string;
  domain: string;
  /** 同义词别名（JSON string[] 原文；解析用 parseAliases） */
  aliases: string;
  source_session_id: string | null;
  importance: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  /** 复习阶段 0..MAX_REVIEW_STAGE（v23 艾宾浩斯；0 = 还没复习过） */
  review_stage: number;
  /** 上次复习时间（**null = 从未复习**，起算点退到 `created_at`） */
  last_reviewed_at: string | null;
  /**
   * 复习范围覆盖位（v28，契约 EBBINGHAUS-SPEC §9）：`null` = **继承领域开关**，
   * 0/1 = 用户对该词条的显式反选/加入。
   * ★ 它不是"该不该复习"的答案——答案由 `COALESCE(词条, 领域, 0)` 现算（见 `term-review.ts`）。
   *   单看这一列会把"继承且领域已开"误读成"不复习"。
   */
  review_enabled: number | null;
}

/** API 返回形状（aliases 已解析；routes 直接 res.json 该形状） */
export type TermApiRow = Omit<TermRow, 'aliases'> & { aliases: string[] };

/** 解析 aliases 列（坏值回退空数组，ADR-4） */
export function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 防再分裂索引（TERM-TIDY-SPEC §7）：
 *  - 同词同域（大小写不敏感）→ 并入（比 SQL UNIQUE 更严，Closure/closure 不再各成一条）
 *  - 别名（跨域）→ 并入（AI 整理判定的同一概念，抽取到别名写法时不再另开新条）
 *  - 同词不同域不并入（closure 在 math 与 english 是两个概念，保持独立）
 */
interface TermIndex {
  find(term: string, domain: string): string | null;
  add(term: string, domain: string, id: string, aliases?: string[]): void;
}

function buildTermIndex(): TermIndex {
  const rows = getDb().prepare('SELECT id, term, domain, aliases FROM term_library').all() as Array<
    Pick<TermRow, 'id' | 'term' | 'domain' | 'aliases'>
  >;
  const byTermDomain = new Map<string, string>();
  const byAlias = new Map<string, string>();
  const add = (term: string, domain: string, id: string, aliases?: string[]) => {
    byTermDomain.set(`${term.toLowerCase()}\u0000${domain.toLowerCase()}`, id);
    for (const a of aliases ?? []) byAlias.set(a.toLowerCase(), id);
  };
  for (const r of rows) add(r.term, r.domain, r.id, parseAliases(r.aliases));
  return {
    find(term, domain) {
      return (
        byTermDomain.get(`${term.toLowerCase()}\u0000${domain.toLowerCase()}`) ??
        byAlias.get(term.toLowerCase()) ??
        null
      );
    },
    add,
  };
}

// ── 抽取（材料 → 词条列表：LLM 协议 + 解析 + 归一）——已拆到 `term-extract.ts` ──
//
// ★ 为什么拆（2026-09-18 v28 复习范围批）：本批给词条加复习范围后本文件涨到 **401 行**，
//   触 AGENTS.md「server `.ts` ≤400 行」红线。拆的判据同 `term-recall.ts`：
//   **抽取**随「AI 抽什么、怎么解析」而变，**入库**随「怎么存、怎么查」而变，
//   两类改动几乎不会同时发生。照仓规**拆文件、不压注释**。
// ★ 用 re-export 而不是让调用方改 import：`chat/flow.test.ts` 与 `routes/document.test.ts`
//   的 `vi.mock('../learning/terms.js')` 都指着本文件——改路径会同时打穿两处 mock。
export { TERMS_PROTOCOL, parseTermsBlock, normalizeTerms, extractTerms } from './term-extract.js';
export type { TermItem } from './term-extract.js';

/**
 * 入库（防再分裂 + UNIQUE(term,domain) 兜底）：先查索引命中并入（同词同域大小写
 * 不敏感 / 命中别名跨域），未命中走 upsert；返回处理条数（非新增行数）。
 *
 * ★ v28 起**写入侧一个字都不用改**：新词条不写 `review_enabled`，自然是 `NULL`（继承领域）
 *   ⇒ 「已开启的领域里 AI 新抽的词条自动进复习池」是**读取侧现算**白拿的，
 *   不需要在这里查一次领域开关再回填（那会多出第二份范围口径，同迁移 v28 注释的取舍）。
 *
 * ★ M2d（2026-09-18）：`ownerId` 是**事件归属**、不是这一行的归属——本批不动 `term_library`
 *   的 SQL（`term_*` 归主在 M2d-2 / v31，消费面 12 文件 + ~80 个 SQL 点，单独一批交付）。
 *   这里要它，是因为下面 `term_added` 事件会让 `activity.ts` 给**这个人**记 XP 与每日计数；
 *   不传的话 `tsc` 直接报错（见 `events/bus.ts` 头注「为什么必填」）。
 */
export function saveTerms(
  items: TermItem[],
  sourceSessionId?: string | null,
  ownerId: string | null = null,
): number {
  const db = getDb();
  const norm = normalizeTerms(items);
  if (norm.length === 0) return 0;
  const insert = db.prepare(
    `INSERT INTO term_library (id, term, definition, domain, source_session_id, importance)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(term, domain) DO UPDATE SET
       definition = CASE WHEN excluded.importance >= term_library.importance THEN excluded.definition ELSE term_library.definition END,
       importance = MAX(term_library.importance, excluded.importance),
       source_session_id = COALESCE(term_library.source_session_id, excluded.source_session_id),
       updated_at = datetime('now')`,
  );
  const mergeInto = db.prepare(
    `UPDATE term_library SET
       definition = CASE WHEN ? >= importance THEN ? ELSE definition END,
       importance = MAX(importance, ?),
       source_session_id = COALESCE(source_session_id, ?),
       updated_at = datetime('now')
     WHERE id = ?`,
  );
  const index = buildTermIndex();
  // ★ 不变式（v19）：`term_library.domain ⊆ term_domain.name`——落词条前先登记领域。
  // 为什么放在**写入侧**而不是靠人工同步：`extractTerms` 的提示词只做「优先复用已有领域」的
  // 软引导，不做白名单硬拦（硬拦会把还没归好类的词条憋回去），所以模型随时会吐出全新领域名；
  // 登记册若靠人同步就必然滞后 ⇒ 领域 Tab 漏项。幂等交给库约束（同 v10 `UNIQUE(kind, content)` 手法）。
  const ensureDomain = db.prepare('INSERT OR IGNORE INTO term_domain (name) VALUES (?)');
  const tx = db.transaction(() => {
    for (const t of norm) {
      const imp = t.importance ?? 0.5;
      const domain = t.domain ?? 'general'; // normalizeTerms 已兜底，类型收口
      ensureDomain.run(domain);
      const hit = index.find(t.term, domain);
      if (hit) {
        // 并入已有行：与 ON CONFLICT 同语义（importance 不低于现值才覆盖释义）
        mergeInto.run(imp, t.definition, imp, sourceSessionId ?? null, hit);
      } else {
        const id = randomUUID();
        insert.run(id, t.term, t.definition, domain, sourceSessionId ?? null, imp);
        index.add(t.term, domain, id);
      }
    }
  });
  tx();
  publishEvent({ type: 'term_added', count: norm.length, ownerId });
  return norm.length;
}

/** 手动存一条（列表页「添加」按钮），已存在（含别名/大小写命中）则更新释义。 */
export function saveOneTerm(term: string, definition: string, domain?: string): TermApiRow {
  const db = getDb();
  const d = (domain ?? '').trim().toLowerCase().slice(0, 30) || 'general';
  const t = term.trim();
  // 同 saveTerms：先登记领域再落词条（v19 不变式）——列表页「添加」与对话工具 manage_terms 都走这里
  db.prepare('INSERT OR IGNORE INTO term_domain (name) VALUES (?)').run(d);
  const hit = buildTermIndex().find(t, d);
  let rowId = hit;
  if (hit) {
    db.prepare(`UPDATE term_library SET definition = ?, updated_at = datetime('now') WHERE id = ?`).run(
      definition.trim(),
      hit,
    );
  } else {
    rowId = randomUUID();
    db.prepare(
      `INSERT INTO term_library (id, term, definition, domain, importance)
       VALUES (?, ?, ?, ?, 0.5)
       ON CONFLICT(term, domain) DO UPDATE SET definition = excluded.definition, updated_at = datetime('now')`,
    ).run(rowId, t, definition.trim(), d);
  }
  const raw = db.prepare('SELECT * FROM term_library WHERE id = ?').get(rowId) as TermRow | undefined;
  if (!raw) throw new Error('词条保存失败'); // 理论不可达：同连接内刚写入
  return { ...raw, aliases: parseAliases(raw.aliases) };
}

/**
 * 词条列表（可按 domain 过滤；keyword 对 term 前缀模糊；JOIN 来源会话标题供 UI 展示）。
 *
 * ★ `review_in_scope`（v28）是**现算的有效范围**，不是 `review_enabled` 那一列——
 *   前端要回答的是"这条词条到底复不复习"（列表行据此显示复习徽标与「纳入/移出」按钮），
 *   而库里那一列可能是 NULL（继承）。让前端自己 COALESCE 一次，就等于把范围判定抄了第二份
 *   （本仓在 `doc-rag` 常量上付过学费）。故范围只在服务端算，前端只读结论。
 */
export function listTerms(
  domain?: string,
  keyword?: string,
): Array<TermApiRow & { source_title: string | null; review_in_scope: number }> {
  const db = getDb();
  const conds: string[] = [];
  const args: unknown[] = [];
  if (domain && domain !== 'all') {
    conds.push('t.domain = ?');
    args.push(domain);
  }
  if (keyword?.trim()) {
    conds.push('t.term LIKE ?');
    args.push(`${keyword.trim()}%`);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT t.*, s.title AS source_title, ${SCOPE_FLAG} AS review_in_scope
         FROM term_library t
         ${SCOPE_JOIN}
         LEFT JOIN sessions s ON s.id = t.source_session_id
       ${where} ORDER BY t.importance DESC, t.usage_count DESC, t.updated_at DESC LIMIT 500`,
    )
    .all(...args) as Array<TermRow & { source_title: string | null; review_in_scope: number }>;
  return rows.map((r) => ({ ...r, aliases: parseAliases(r.aliases) }));
}

/**
 * 按词条名查行（对话工具用：模型手里只有词条名没有 id）。
 * 大小写不敏感；term 精确命中优先，其次别名命中（AI 整理判定的同一概念）。
 * 多条同名时取最近更新的那条。找不到返回 null。
 */
export function findTermByName(name: string): TermRow | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const rows = getDb()
    .prepare('SELECT * FROM term_library ORDER BY updated_at DESC')
    .all() as TermRow[];
  return (
    rows.find((r) => r.term.toLowerCase() === n) ??
    rows.find((r) => parseAliases(r.aliases).some((a) => a.toLowerCase() === n)) ??
    null
  );
}

/** 删除词条。 */
export function removeTerm(id: string): void {
  getDb().prepare('DELETE FROM term_library WHERE id = ?').run(id);
}

/** 编辑词条（列表页编辑：释义/领域/重要度）。 */
export function updateTerm(id: string, patch: { definition?: string; domain?: string; importance?: number }): TermApiRow | null {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM term_library WHERE id = ?').get(id) as TermRow | undefined;
  if (!cur) return null;
  const importance = patch.importance === undefined ? cur.importance : Math.min(1, Math.max(0, Number(patch.importance)));
  const domain = patch.domain?.trim().toLowerCase().slice(0, 30) || cur.domain;
  const definition = patch.definition?.trim() || cur.definition;
  db.prepare('UPDATE term_library SET definition = ?, domain = ?, importance = ?, updated_at = datetime(\'now\') WHERE id = ?').run(
    definition,
    domain,
    importance,
    id,
  );
  const raw = db.prepare('SELECT * FROM term_library WHERE id = ?').get(id) as TermRow | undefined;
  return raw ? { ...raw, aliases: parseAliases(raw.aliases) } : null;
}

// ── 检索（flow.ts 注入用）——已按「关注点分家」拆到 `term-recall.ts` ──
//
// ★ 为什么拆（2026-09-18 v0.2.49 记忆联动 P1 批）：本批把提及流水接进 `countUsage` 后，
//   本文件涨到 **409 行**触 AGENTS.md「.ts ≤400 行」红线。照仓规**拆文件、不压注释**——
//   而检索与入库本就是两个关注点：**检索只读**（随打分策略变）、**入库写库**（随抽取协议变）。
// ★ 为什么用 re-export 而不是让调用方改 import：`chat/context-segments.ts` 与
//   `chat/flow.test.ts`/`routes/document.test.ts` 的 `vi.mock('../learning/terms.js')`
//   都指着本文件——改路径会同时打穿三处 mock（那不是重构，是给自己埋红灯）。
export { getRelevantTerms } from './term-recall.js';

/** 回复文本是否用到某词条（term + 别名，大小写不敏感；英文词按边界匹配防子串误报）。 */
function replyHitsKey(replyLower: string, key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!k) return false;
  if (!/[a-z]/.test(k)) return replyLower.includes(k); // 中文等无词边界概念：子串即可
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(replyLower);
}

/**
 * 回复完成后扫描命中词条（term + 别名）：`usage_count + 1`、`last_used_at` 更新，
 * 并在**同一事务**里落一行提及流水（契约 `docs/MEMORY-TREND-SPEC.md` §1.4）。
 *
 * ★ 为什么计数与流水必须同事务：两处一旦分叉（计数加了、流水没落），差值此后再也无法对齐
 *   ——「总提及数」与「近期提及数」本就是两个独立口径（前者含历史、后者只有建表之后），
 *   没有任何交叉校验能发现这种分叉。
 * ★ 顺带去掉旧版"命中列表算两遍"的重复扫描（原实现第 387 与 391 行各 filter 一次）。
 * ★ `ownerId` 可选且默认 `null`（＝本地单人模式，同 MEMORY-SPEC / TENANCY-SPEC §7）：
 *   不逼既有调用点改签名，且"漏传"的后果是退回现状，不是串台。
 */
export function countUsage(replyText: string, ownerId: string | null = null, now: Date = new Date()): number {
  if (!replyText?.trim()) return 0;
  const replyLower = replyText.toLowerCase();
  const rows = getDb().prepare('SELECT id, term, aliases, domain FROM term_library').all() as Array<
    Pick<TermRow, 'id' | 'term' | 'aliases' | 'domain'>
  >;
  const hits = rows.filter((r) => [r.term, ...parseAliases(r.aliases)].some((k) => replyHitsKey(replyLower, k)));
  if (hits.length === 0) return 0;
  const db = getDb();
  const upd = db.prepare('UPDATE term_library SET usage_count = usage_count + 1, last_used_at = datetime(\'now\') WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of hits) upd.run(r.id);
    // 一次批量写：`recordMentions` 内部 prepare 一次，放进循环会 prepare N 次。
    // 它在事务**内**被调用，故自身不再开事务（嵌套 transaction 会抛，见 mention.ts 文件头）。
    recordMentions(
      hits.map((r) => ({ termId: r.id, domain: r.domain })),
      ownerId,
      now,
    );
  });
  tx();
  return hits.length;
}
