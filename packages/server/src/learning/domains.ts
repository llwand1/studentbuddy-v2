/**
 * learning/domains — 领域库（v19：领域升为一等实体，2026-09-17 契约）。
 *
 * **为什么单开一个文件**：`terms.ts` 381 行、`tidy.ts` 394 行，两份都贴着 server ≤400 行
 * 红线，领域 CRUD 的增量无处安放（AGENTS「贴线前先开新文件」）。领域与词条在**数据上**
 * 仍是「一张登记表 + 一列引用名」的两张表，但在**管理语义上已与词条对等**——
 * 词条有的增删改查，领域一件不少。
 *
 * ★ 依赖方向（**不能反**，反了成环）：本文件 → `tidy.ts`（复用 `renameDomain` 的
 *   「同名跨域词条先并入」防御），而 `tidy.ts` → `terms.ts`。本文件**刻意不 import `terms.ts`**：
 *   `terms.ts` 需要「已有领域清单」时（`extractTerms` 的防碎裂引导）自带 SQL 直查 `term_domain`。
 *   若让 `terms → domains` 也成立，就成了 `terms → domains → tidy → terms` 环；ESM 下虽多半能跑，
 *   但仓库既有规矩是**断环**（见 `web/src/lib/api-request.ts` 抽出时的注释），故保持单向。
 *   同理，领域统计（`domainStats`）也放在本文件——`terms.ts` 已贴线塞不进去。
 *
 * ★ 三条语义决策（改动前先读，都很容易想反）：
 *  1. **改名的权威动作是改词条、不是改登记册**。顺序必须「先迁词条（事实）→ 再同步登记册
 *     （索引）」。反过来的话，中途失败会留下「词条指着一个登记册里已不存在的领域」的态。
 *     迁词条一律走 `tidy.renameDomain`，因为**目标域已有同名词条时会撞 `UNIQUE(term, domain)`**，
 *     它内含「先并入再改名」的防御（本仓实测踩过这个约束，见 tidy.ts 的注释）。
 *  2. **删除不删词条**：词条一律迁 `general`（`DEFAULT_DOMAIN`）。领域是**分组视角**，
 *     删分组不该炸掉组里的内容。（2026-09-17 拍板口径。）
 *  3. **`general` 不可删**：它是词条未归类时的落点，也是删域时的迁移目标。删了它，
 *     迁移就没有终点，不变式 `term_library.domain ⊆ term_domain.name` 也守不住。
 *
 * ⚠️ 与 `tidy.ts` 的分工：`tidy` 面向 **AI 整理**（LLM 方案 + 点名操作，含合并同义词这类
 * 词条级动作）；本文件面向 **领域自身的 CRUD**（用户/工具直接调用，确定性）。领域改名一件事
 * 两边都会触发，故**词条迁移的实现收口在 tidy 的 `renameDomainTx`**，本文件只管「迁完同步登记册」。
 */
import { getDb } from '../storage/db.js';
import { renameDomain } from './tidy.js';
// ★ 依赖方向仍守单向：`mention.ts` 只依赖 storage/ownership/shared，**不反向依赖本文件**
//   或 `terms.ts`，故不成环（本文件头写的「terms → domains → tidy → terms 环」那条约束不受影响）。
import { domainMentionTotals } from './mention.js';
// ★ v28 复习范围：范围**取值**表达式向 `term-review.ts` 要，不在这里手抄一遍
//   （抄一遍就有两份口径，将来范围规则一改，Tab 上的「已纳入 N 条」与复习概览就对不上）。
//   依赖方向安全：`term-review.ts` 只依赖 storage/db 与 @sb/shared，**不反向依赖本文件**。
import { SCOPE_FLAG } from './term-review.js';

/** 默认领域：词条未归类时的落点，也是删域时的迁移目标（**不可删除**）。 */
export const DEFAULT_DOMAIN = 'general';

/** 领域说明上限（与词条释义同量级，防把整段文章塞进 note）。 */
const NOTE_MAX = 200;

/**
 * 领域操作的业务错误：`status` 由路由**直通**给客户端。
 * 仓库既有手法（见 `server/src/routes/choice.ts` 头注释）：**域层给状态码，薄路由不翻译不包装**
 * ——否则「领域不存在」与「领域名非法」会被路由一律压成 400，前端就没法区分该提示还是该刷新列表。
 */
export class DomainError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface DomainRow {
  name: string;
  note: string;
  created_at: string;
  updated_at: string;
}

/** API 返回形状：登记册行 + 派生计数（**count 不是表里的列**）。 */
export type DomainApiRow = DomainRow & { count: number };

/**
 * 领域名规范化：去空白 + 小写 + 截 30 字符。
 * 与 `normalizeTerms`（词条侧）和 `tidy.normDomain`（整理侧）**同口径**——三处不一致会让
 * 「同一个领域」在库里存成两行（`Math` 与 `math`），Tab 上看着是俩。
 */
export function normalizeDomainName(raw?: string | null): string {
  return (raw ?? '').trim().toLowerCase().slice(0, 30);
}

/** 单行查询（含派生计数）。不存在返回 null。 */
function getDomainRow(name: string): DomainApiRow | null {
  const row = getDb()
    .prepare(
      `SELECT d.name, d.note, d.created_at, d.updated_at,
              (SELECT COUNT(*) FROM term_library t WHERE t.domain = d.name) AS count
         FROM term_domain d WHERE d.name = ?`,
    )
    .get(name) as DomainApiRow | undefined;
  return row ?? null;
}

function countTerms(domain: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS c FROM term_library WHERE domain = ?').get(domain) as { c: number }).c;
}

/**
 * 新建领域（登记册新增，**允许零词条**——这正是「领域是一等实体」的核心收益：
 * 可以先把领域建好，再慢慢往里放词）。
 * 已存在时不覆盖既有 note（「新建」不该顺手改写别人的说明），`created: false` 如实回报。
 */
export function createDomain(rawName: string, note = ''): { row: DomainApiRow; created: boolean } {
  const name = normalizeDomainName(rawName);
  if (!name) throw new DomainError('领域名不能为空');
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO term_domain (name, note) VALUES (?, ?)')
    .run(name, note.trim().slice(0, NOTE_MAX));
  const row = getDomainRow(name);
  if (!row) throw new DomainError('领域创建失败', 500); // 理论不可达：刚写入或已存在，两者都查得到
  return { row, created: info.changes > 0 };
}

/** 改领域说明（只动 note；领域名改动走 `renameDomainEntry`，两者刻意分开）。 */
export function updateDomain(rawName: string, note: string): DomainApiRow | null {
  const name = normalizeDomainName(rawName);
  const info = getDb()
    .prepare(`UPDATE term_domain SET note = ?, updated_at = datetime('now') WHERE name = ?`)
    .run(note.trim().slice(0, NOTE_MAX), name);
  if (info.changes === 0) return null;
  return getDomainRow(name);
}

export interface RenameDomainResult {
  from: string;
  to: string;
  /** 随改名迁移的词条数（0 = 空领域改名，只动登记册） */
  moved: number;
  /** 目标领域原本就已存在 ⇒ 两域合一，旧名从登记册移除 */
  merged: boolean;
}

/**
 * 领域改名（用户/工具直接调用；`tidy_terms(rename_domain)` 走 tidy 自己的通道，不走这里）。
 * 流程：校验 → 迁词条（有词条才走 tidy，否则空领域只动登记册）→ 同步登记册。
 */
export function renameDomainEntry(rawFrom: string, rawTo: string): RenameDomainResult {
  const from = normalizeDomainName(rawFrom);
  const to = normalizeDomainName(rawTo);
  if (!from || !to) throw new DomainError('领域名不能为空');
  if (from === to) throw new DomainError('新旧领域名相同');
  if (!getDomainRow(from)) throw new DomainError(`没有名为「${from}」的领域`, 404);

  const moved = countTerms(from);
  const targetExisted = getDomainRow(to) !== null;

  // 步骤 1：迁词条（事实层）。有词条才调——tidy.renameDomain 拿词条行当存在性凭证，
  // 空领域传进去会直接报「没有名为 X 的领域」（v19 之前领域建不出来也正因为这条）。
  if (moved > 0) {
    const r = renameDomain(from, to);
    if (r.result === 'error') throw new DomainError(r.message ?? '领域改名失败', 409);
  }

  // 步骤 2：同步登记册（索引层）。目标已存在 ⇒ 合一（删旧名、留目标行及其 note）。
  const db = getDb();
  const tx = db.transaction(() => {
    if (targetExisted) db.prepare('DELETE FROM term_domain WHERE name = ?').run(from);
    else db.prepare(`UPDATE term_domain SET name = ?, updated_at = datetime('now') WHERE name = ?`).run(to, from);
  });
  tx();

  return { from, to, moved, merged: targetExisted };
}

export interface RemoveDomainResult {
  name: string;
  /** 迁到默认领域的词条数 */
  moved: number;
  target: string;
}

/**
 * 删除领域：词条迁 `general`（**不删词条**），登记册移除旧名。
 * 拒绝删 `general`（它是迁移终点）；迁词条复用改名通道，因而同样享有「目标域同名词条先并入」
 * 的防御——`general` 里已有一条 `closure` 时删掉 math 域，两条 `closure` 会并成一条而不是炸约束。
 */
export function removeDomain(rawName: string): RemoveDomainResult {
  const name = normalizeDomainName(rawName);
  if (!name) throw new DomainError('领域名不能为空');
  if (!getDomainRow(name)) throw new DomainError(`没有名为「${name}」的领域`, 404);
  if (name === DEFAULT_DOMAIN) throw new DomainError(`「${DEFAULT_DOMAIN}」是默认领域，不能删除`, 409);

  const moved = countTerms(name);
  if (moved > 0) {
    const r = renameDomain(name, DEFAULT_DOMAIN);
    if (r.result === 'error') throw new DomainError(r.message ?? '词条迁移失败', 409);
  }
  getDb().prepare('DELETE FROM term_domain WHERE name = ?').run(name);
  return { name, moved, target: DEFAULT_DOMAIN };
}

/**
 * 领域统计（前端 Tab + 顶部统计；`GET /api/terms/domains` 的响应形状）。
 *
 * ★ 为什么放本文件而不是 `terms.ts`：v19 之后它纯是领域的事；且 `terms.ts` 当时已 381 行，
 * 这段加进去直接顶破 400 行红线（server 单文件门禁，见 AGENTS「工程红线」）。
 *
 * 以**登记册为左表**，故**空领域也会出现**（count=0）——这是「领域是一等实体」的可见证据，
 * 也是与 v19 之前（`GROUP BY domain` 现算，没词条就不存在）的本质差别。
 *
 * 末段 `UNION ALL` 兜底「孤儿域」（有词条但登记册里没有）：正常**恒为空集**——写入侧
 * （`saveTerms` / `saveOneTerm`）落新 domain 时同步登记，见 v19 迁移注释的不变式。
 * 留着它是为了**不在异常态下静默丢数据**：漏登记的领域宁可在 Tab 上多一格
 * （用户仍能看见它、改名、删掉），也不能让它的词条在列表里"隐身"。
 */
export function domainStats(): {
  total: number;
  /**
   * count 为派生值；note 来自登记册（孤儿域为空串）。按 count 降序、同数按名字升序。
   * ★ `reviewEnabled`/`reviewCount`（v28 复习范围，契约 EBBINGHAUS-SPEC §9）：
   *   `reviewEnabled` 是**领域开关本身**（用户点出来的），`reviewCount` 是**有效范围内的词条数**
   *   （现算，含词条级覆盖）。两者**不可互相换算**：开关开着但被逐条反选掉时
   *   `reviewEnabled=true` 而 `reviewCount` 可能远小于 `count`——前端的三态勾选框正是靠
   *   这个差看出"部分纳入"。孤儿域恒 `reviewEnabled=false`（登记册里没有它，没有开关可谈）。
   */
  domains: Array<{ domain: string; count: number; note: string; mentionCount: number; reviewEnabled: boolean; reviewCount: number }>;
  today: number;
  /**
   * **偏好领域**（契约 MEMORY-TREND-SPEC §2.1）：按**总提及数**降序；同数按词条数降序、
   * 再按领域名升序（**全序**，保证同一份数据每次返回的顺序逐字相同）。
   * **只含提及数 > 0 的领域**——「从未被提及」不是偏好，列出来只会稀释这个榜的意义。
   *
   * ★ 为什么不设最小阈值（如「提及 ≥3 才算偏好」）：阈值是拍脑袋的数，且会让小样本用户
   *   永远看到空列表。改为**如实返回全序**，由调用方自己截 top N，并在文案里带上计数
   *   （「计算机网络（42 次）」）——**让用户看见依据，而不是看见一个结论**。
   */
  preferred: Array<{ domain: string; mentionCount: number }>;
} {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS c FROM term_library').get() as { c: number }).c;
  const domains = db
    .prepare(
      `SELECT d.name AS domain, d.note AS note, d.review_enabled AS review_enabled, COUNT(t.id) AS count,
              COALESCE(SUM(${SCOPE_FLAG}), 0) AS review_count
         FROM term_domain d LEFT JOIN term_library t ON t.domain = d.name
        GROUP BY d.name, d.note, d.review_enabled
        UNION ALL
       SELECT t.domain AS domain, '' AS note, 0 AS review_enabled, COUNT(*) AS count,
              COALESCE(SUM(${SCOPE_FLAG}), 0) AS review_count
         FROM term_library t LEFT JOIN term_domain d ON d.name = t.domain
        WHERE d.name IS NULL
        GROUP BY t.domain
        ORDER BY count DESC, domain ASC`,
    )
    .all() as Array<{ domain: string; count: number; note: string; review_enabled: number; review_count: number }>;
  const today = (
    db.prepare("SELECT COUNT(*) AS c FROM term_library WHERE created_at >= date('now')").get() as { c: number }
  ).c;

  // ★ 提及口径不在这里重写 SQL：一律向 `mention.ts` 要（那里的 `domainMentionTotals` 是唯一实现）。
  //   本文件自己写一遍 `SUM(usage_count)` 就会有两份口径，将来加归属过滤时必漏一边。
  const mentions = domainMentionTotals();
  const withMentions = domains.map(({ review_enabled, review_count, ...r }) => ({
    ...r,
    mentionCount: mentions.get(r.domain) ?? 0,
    // 库层是 0/1，对外给布尔：`reviewEnabled` 是"用户点出来的开关"，
    // `reviewCount` 是"现算的有效条数"——前端三态（全选/部分/未选）取的就是这一对。
    reviewEnabled: review_enabled === 1,
    reviewCount: review_count,
  }));
  const preferred = withMentions
    .filter((d) => d.mentionCount > 0)
    .sort(
      (a, b) =>
        b.mentionCount - a.mentionCount ||
        b.count - a.count ||
        // 领域名在 `term_domain` 里是主键 ⇒ 不会相等，故不必处理 ties（省一个分支）
        (a.domain < b.domain ? -1 : 1),
    )
    .map((d) => ({ domain: d.domain, mentionCount: d.mentionCount }));

  return { total, domains: withMentions, today, preferred };
}
