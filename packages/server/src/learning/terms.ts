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
 *     UNIQUE(owner_id, term, domain) upsert（同词条取更高 importance、更新释义）。
 *  3. 使用：getRelevantTerms 按关键词重叠度 + 重要度 + 近期使用排序，注入后续对话
 *     （flow.ts 软性提示 AI 优先使用，保持自然）。★ **已拆到 `term-recall.ts`**。
 *  4. 计数：countUsage 扫描已完成回复命中词条（term + 别名，大小写不敏感，
 *     英文词按边界匹配防子串误报），累积 usage_count（反馈「记住了多少」）。
 *  5. 范围：v28 起复习改成**选择式**——`review_enabled` 覆盖位 + 领域开关，
 *     有效范围由 `term-review.ts` 现算（契约 EBBINGHAUS-SPEC §9）。
 *
 * ── M2d-2（v31，2026-09-18）：词条库归主 ─────────────────────────────────────
 *
 * ★ **`ownerId` 在本文件是必填参数**（`string | null`，**不给默认值**）：默认值会让"漏传"
 *   退化成"按未登录处理"，而漏传的表现是**静默串台**（读到别人的词条）或**静默丢写**
 *   （写进无主行，主人自己再也看不见）——两种都不报错。⇒ 签名强制传入，`tsc` 逐一点名。
 *
 * ★ **归属值一律经 `ownerForWrite(ownerId)`**（`null` ⇒ `''` = 无主行），读写同口径。
 *   不能用 `ownerFilter` 的"`null` 就不加条件"——那会**列出全站词条**。
 *   完整判据见 `storage/migrations-list-v31.ts` 头注与 `auth/ownership.ts`。
 *
 * ★ **`UNIQUE(term, domain)` → `UNIQUE(owner_id, term, domain)`**：两处 upsert 的
 *   **冲突目标**必须同步改（`ON CONFLICT(owner_id, term, domain)`）——SQL 是字符串，
 *   编译期零信号，只改迁移不改这里就是**运行时 500**。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { publishEvent } from '../events/bus.js';
// 入库前要归一（抽取侧的 `normalizeTerms`）；类型 `TermItem` 同源，避免两处各写一份形状。
import { normalizeTerms, type TermItem } from './term-extract.js';
// ★ v28 复习范围：有效范围的**取值与连接**都向 `term-review.ts` 要（那里是唯一实现），
//   本文件只负责把它挂进列表查询。依赖方向安全：`term-review.ts` 不反向依赖本文件，
//   故不成环（对比 `terms → domains → tidy → terms` 那条必须避开的环，见 domains.ts 头注释）。
import { SCOPE_FLAG, SCOPE_JOIN } from './term-review.js';

export interface TermRow {
  /** 归属用户（v31）：`''` = 无主行（本地单人模式的历史数据，登录用户看不见） */
  owner_id: string;
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

/**
 * API 返回形状（aliases 已解析；routes 直接 res.json 该形状）。
 * ★ `owner_id` 会随 `SELECT *` 一起进响应——那是**请求者自己的 id**，不是泄露；
 *   刻意不剥：剥它要给每个查询手写 18 列清单，而漏写一列是**静默丢字段**。
 */
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
 *
 * ★ v31 起**按归属建索引**：若仍拉全表，A 的「牛顿第二定律」会被 B 的同名词条命中并
 *   **并入 B 的行**（`mergeInto` 拿的是 A 的 id，但索引给的是 B 的 id）——写反了不报错，
 *   只是 A 的词条凭空消失、B 的释义被 A 覆盖。故 `WHERE owner_id = ?` 不是优化，是正确性。
 */
interface TermIndex {
  find(term: string, domain: string): string | null;
  add(term: string, domain: string, id: string, aliases?: string[]): void;
}

function buildTermIndex(ownerId: string | null): TermIndex {
  const rows = getDb()
    .prepare('SELECT id, term, domain, aliases FROM term_library WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as Array<Pick<TermRow, 'id' | 'term' | 'domain' | 'aliases'>>;
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
 * 入库（防再分裂 + UNIQUE(owner_id,term,domain) 兜底）：先查索引命中并入（同词同域大小写
 * 不敏感 / 命中别名跨域），未命中走 upsert；返回处理条数（非新增行数）。
 *
 * ★ v28 起**写入侧一个字都不用改**：新词条不写 `review_enabled`，自然是 `NULL`（继承领域）
 *   ⇒ 「已开启的领域里 AI 新抽的词条自动进复习池」是**读取侧现算**白拿的，
 *   不需要在这里查一次领域开关再回填（那会多出第二份范围口径，同迁移 v28 注释的取舍）。
 *
 * ★ `ownerId` 是**双份语义**（v31 起，别只看一半）：它既是这一行的**归属**（落
 *   `term_library.owner_id`），也是下面 `term_added` 事件的**归属**（`activity.ts` 据此给
 *   这个人记 XP 与每日计数）。两者用同一个值不是巧合——"谁的学习数据"与"谁的动作"在
 *   本仓是同一个答案；若将来要分开，必须**显式拆成两个参数**，不要让它悄悄分叉。
 */
export function saveTerms(
  items: TermItem[],
  sourceSessionId: string | null,
  ownerId: string | null,
): number {
  const db = getDb();
  const norm = normalizeTerms(items);
  if (norm.length === 0) return 0;
  const owner = ownerForWrite(ownerId);
  // ★ 冲突目标必须是**三列复合**（迁移 v31 把 UNIQUE 改成了 `(owner_id, term, domain)`）：
  //   写 `ON CONFLICT(term, domain)` 会因"找不到匹配的唯一索引"直接 500。
  const insert = db.prepare(
    `INSERT INTO term_library (owner_id, id, term, definition, domain, source_session_id, importance)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, term, domain) DO UPDATE SET
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
     WHERE id = ? AND owner_id = ?`,
  );
  const index = buildTermIndex(ownerId);
  // ★ 不变式（v19）：`term_library.domain ⊆ term_domain.name`——落词条前先登记领域。
  // 为什么放在**写入侧**而不是靠人工同步：`extractTerms` 的提示词只做「优先复用已有领域」的
  // 软引导，不做白名单硬拦（硬拦会把还没归好类的词条憋回去），所以模型随时会吐出全新领域名；
  // 登记册若靠人同步就必然滞后 ⇒ 领域 Tab 漏项。幂等交给库约束（同 v10 `UNIQUE(kind, content)` 手法）。
  // ★ v31 起幂等键是 `(owner_id, name)` ⇒ 每个用户各自登记一份；漏带归属的话，
  //   `INSERT OR IGNORE` 会**因为别人已经登记过而静默不登记**，本用户的领域 Tab 就少一格。
  const ensureDomain = db.prepare('INSERT OR IGNORE INTO term_domain (owner_id, name) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const t of norm) {
      const imp = t.importance ?? 0.5;
      const domain = t.domain ?? 'general'; // normalizeTerms 已兜底，类型收口
      ensureDomain.run(owner, domain);
      const hit = index.find(t.term, domain);
      if (hit) {
        // 并入已有行：与 ON CONFLICT 同语义（importance 不低于现值才覆盖释义）
        mergeInto.run(imp, t.definition, imp, sourceSessionId ?? null, hit, owner);
      } else {
        const id = randomUUID();
        insert.run(owner, id, t.term, t.definition, domain, sourceSessionId ?? null, imp);
        index.add(t.term, domain, id);
      }
    }
  });
  tx();
  publishEvent({ type: 'term_added', count: norm.length, ownerId });
  return norm.length;
}

/** 手动存一条（列表页「添加」按钮），已存在（含别名/大小写命中）则更新释义。 */
export function saveOneTerm(
  term: string,
  definition: string,
  domain: string | undefined,
  ownerId: string | null,
): TermApiRow {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const d = (domain ?? '').trim().toLowerCase().slice(0, 30) || 'general';
  const t = term.trim();
  // 同 saveTerms：先登记领域再落词条（v19 不变式）——列表页「添加」与对话工具 upsert_term 都走这里
  db.prepare('INSERT OR IGNORE INTO term_domain (owner_id, name) VALUES (?, ?)').run(owner, d);
  const hit = buildTermIndex(ownerId).find(t, d);
  let rowId = hit;
  if (hit) {
    db.prepare(
      `UPDATE term_library SET definition = ?, updated_at = datetime('now') WHERE id = ? AND owner_id = ?`,
    ).run(definition.trim(), hit, owner);
  } else {
    rowId = randomUUID();
    db.prepare(
      `INSERT INTO term_library (owner_id, id, term, definition, domain, importance)
       VALUES (?, ?, ?, ?, ?, 0.5)
       ON CONFLICT(owner_id, term, domain) DO UPDATE SET definition = excluded.definition, updated_at = datetime('now')`,
    ).run(owner, rowId, t, definition.trim(), d);
  }
  const raw = db
    .prepare('SELECT * FROM term_library WHERE id = ? AND owner_id = ?')
    .get(rowId, owner) as TermRow | undefined;
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
 *
 * ★ v31：`t.owner_id = ?` 是**恒真条件**（第一个 cond），不是可选过滤——未登录（`null`）
 *   落到 `''`，于是**只看无主行**。若按 `ownerFilter` 的"`null` 就不加条件"写，
 *   这一行会列出**全站**词条（`SELECT * FROM term_library`），是过渡期最直接的一处泄露。
 */
export function listTerms(
  domain: string | undefined,
  keyword: string | undefined,
  ownerId: string | null,
): Array<TermApiRow & { source_title: string | null; review_in_scope: number }> {
  const db = getDb();
  const conds: string[] = ['t.owner_id = ?'];
  const args: unknown[] = [ownerForWrite(ownerId)];
  if (domain && domain !== 'all') {
    conds.push('t.domain = ?');
    args.push(domain);
  }
  if (keyword?.trim()) {
    conds.push('t.term LIKE ?');
    args.push(`${keyword.trim()}%`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
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
export function findTermByName(name: string, ownerId: string | null): TermRow | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const rows = getDb()
    .prepare('SELECT * FROM term_library WHERE owner_id = ? ORDER BY updated_at DESC')
    .all(ownerForWrite(ownerId)) as TermRow[];
  return (
    rows.find((r) => r.term.toLowerCase() === n) ??
    rows.find((r) => parseAliases(r.aliases).some((a) => a.toLowerCase() === n)) ??
    null
  );
}

/**
 * 删除词条。
 * ★ 归属判据进 `WHERE`（不是先查后判）：`DELETE … WHERE id = ? AND owner_id = ?` 天然幂等，
 *   别人删不到我的、我也删不到别人的，且**不泄露 id 是否存在**（删 0 行与删不存在的 id 同形）。
 */
export function removeTerm(id: string, ownerId: string | null): void {
  getDb()
    .prepare('DELETE FROM term_library WHERE id = ? AND owner_id = ?')
    .run(id, ownerForWrite(ownerId));
}

/** 编辑词条（列表页编辑：释义/领域/重要度）。 */
export function updateTerm(
  id: string,
  patch: { definition?: string; domain?: string; importance?: number },
  ownerId: string | null,
): TermApiRow | null {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const cur = db
    .prepare('SELECT * FROM term_library WHERE id = ? AND owner_id = ?')
    .get(id, owner) as TermRow | undefined;
  if (!cur) return null;
  const importance = patch.importance === undefined ? cur.importance : Math.min(1, Math.max(0, Number(patch.importance)));
  const domain = patch.domain?.trim().toLowerCase().slice(0, 30) || cur.domain;
  const definition = patch.definition?.trim() || cur.definition;
  // ★ 改 domain 时要把**新领域**也登记进册（v19 不变式按用户各自成立）——否则
  //   `domainStats` 会把它当"孤儿域"兜底显示，而 `term_domain` 里查不到它。
  db.prepare('INSERT OR IGNORE INTO term_domain (owner_id, name) VALUES (?, ?)').run(owner, domain);
  db.prepare(
    `UPDATE term_library SET definition = ?, domain = ?, importance = ?, updated_at = datetime('now')
      WHERE id = ? AND owner_id = ?`,
  ).run(definition, domain, importance, id, owner);
  const raw = db
    .prepare('SELECT * FROM term_library WHERE id = ? AND owner_id = ?')
    .get(id, owner) as TermRow | undefined;
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
// ── 使用计数与提及流水（回复完成后触发）——已按「关注点分家」拆到 `term-usage.ts` ──
//
// ★ 为什么拆（2026-09-18 v31 M2d-2 批）：加归属后本文件涨到 404 行触「server .ts ≤400」红线。
//   照仓规**拆文件、不压注释**——入库/增删改查由「抽到什么、用户点了什么」驱动，
//   本块由「**一轮回复完成了**」驱动，触发点与前者几乎不重叠（同 term-extract / term-recall 判据）。
// ★ 用 re-export 而不是让调用方改 import：多处 `vi.mock('../learning/terms.js')` 指着本文件。
export { countUsage } from './term-usage.js';
