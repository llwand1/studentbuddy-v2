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
 * ── M2d-2（v31，2026-09-18）：领域库归主 ───────────────────────────────────────
 *
 * ★ **`ownerId` 在本文件必填**（`string | null`，不给默认值）：默认值会让"漏传"退化成
 *   "按未登录处理"，表现是**静默串台**（A 看到 B 的领域）或**静默丢写**（写进无主行）。
 *   归属值一律经 `ownerForWrite(ownerId)`（`null` ⇒ `''` = 无主行），读写同口径——
 *   本文件全是**聚合读**（`COUNT`/`SUM`）与**单值读**（`.get()`），按 M2d-1 判据
 *   不能用 `ownerFilter` 的「`null` 就不加条件」（那会把全站领域并成一个列表）。
 *
 * ★ **JOIN 条件必须带 `AND t.owner_id = d.owner_id`**（本文件最容易漏的一处）：
 *   `term_domain` 与 `term_library` 现在**各有一份 owner**。只写 `t.domain = d.name`
 *   会把「A 的领域行」与「B 的同名词条」连起来 ⇒ A 的 Tab 上 count 里混着 B 的词条，
 *   而两个人都看不出异常。这条与 `domainStats` 的 `UNION ALL` 分支同源。
 *
 * ★ **`general` 每用户懒建 + 读路径补建**（2026-09-18 老板拍板）：归主后 `general` 不再是
 *   全站一行，但它是「词条未归类的落点」与「删域的迁移终点」，**每个用户都必须有一份**。
 *   写入侧（`saveTerms`/`saveOneTerm` 落新 domain 时 `INSERT OR IGNORE`）会自动登记，
 *   故无需额外代码；`domainStats` 再补一次是为了**观感一致**——新用户打开领域 Tab
 *   恒有一格 `general`（与归主前一致），而不是空列表。★ 孤儿行的 `general` 留给
 *   本地单人模式（`owner_id = ''`），两者互不可见。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
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

/**
 * 保证该用户有一行 `general`（懒建，幂等）。
 * ★ 靠 `INSERT OR IGNORE` + `PK(owner_id, name)` 去重——不要改成"先 SELECT 再 INSERT"：
 *   那是两条语句之间的竞态，且 PK 已经在拦了，先查一遍纯属多余。
 * ★ 调用点两处：`domainStats`（**读路径补建**，让新用户 Tab 恒有一格）与
 *   `removeDomain`（迁词条前必须保证终点存在，否则留下"词条指向不存在的领域"）。
 */
export function ensureDefaultDomain(ownerId: string | null): void {
  getDb()
    .prepare('INSERT OR IGNORE INTO term_domain (owner_id, name, note) VALUES (?, ?, ?)')
    .run(ownerForWrite(ownerId), DEFAULT_DOMAIN, '');
}

/** 单行查询（含派生计数）。不存在返回 null。 */
function getDomainRow(name: string, ownerId: string | null): DomainApiRow | null {
  const owner = ownerForWrite(ownerId);
  const row = getDb()
    .prepare(
      `SELECT d.name, d.note, d.created_at, d.updated_at,
              (SELECT COUNT(*) FROM term_library t
                WHERE t.domain = d.name AND t.owner_id = d.owner_id) AS count
         FROM term_domain d WHERE d.owner_id = ? AND d.name = ?`,
    )
    .get(owner, name) as DomainApiRow | undefined;
  return row ?? null;
}

function countTerms(domain: string, ownerId: string | null): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ? AND domain = ?')
      .get(ownerForWrite(ownerId), domain) as { c: number }
  ).c;
}

/**
 * 新建领域（登记册新增，**允许零词条**——这正是「领域是一等实体」的核心收益：
 * 可以先把领域建好，再慢慢往里放词）。
 * 已存在时不覆盖既有 note（「新建」不该顺手改写别人的说明），`created: false` 如实回报。
 * ★ 「已存在」判据现在是 `(owner_id, name)`：A 建了 `物理` 不影响 B 也建 `物理`（改前 `name`
 *   单列 PK 会直接撞，B 只能拿到 A 那行）。
 */
export function createDomain(
  rawName: string,
  note: string,
  ownerId: string | null,
): { row: DomainApiRow; created: boolean } {
  const name = normalizeDomainName(rawName);
  if (!name) throw new DomainError('领域名不能为空');
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO term_domain (owner_id, name, note) VALUES (?, ?, ?)')
    .run(ownerForWrite(ownerId), name, note.trim().slice(0, NOTE_MAX));
  const row = getDomainRow(name, ownerId);
  if (!row) throw new DomainError('领域创建失败', 500); // 理论不可达：刚写入或已存在，两者都查得到
  return { row, created: info.changes > 0 };
}

/** 改领域说明（只动 note；领域名改动走 `renameDomainEntry`，两者刻意分开）。 */
export function updateDomain(rawName: string, note: string, ownerId: string | null): DomainApiRow | null {
  const name = normalizeDomainName(rawName);
  const info = getDb()
    .prepare(`UPDATE term_domain SET note = ?, updated_at = datetime('now') WHERE owner_id = ? AND name = ?`)
    .run(note.trim().slice(0, NOTE_MAX), ownerForWrite(ownerId), name);
  if (info.changes === 0) return null;
  return getDomainRow(name, ownerId);
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
export function renameDomainEntry(rawFrom: string, rawTo: string, ownerId: string | null): RenameDomainResult {
  const from = normalizeDomainName(rawFrom);
  const to = normalizeDomainName(rawTo);
  if (!from || !to) throw new DomainError('领域名不能为空');
  if (from === to) throw new DomainError('新旧领域名相同');
  if (!getDomainRow(from, ownerId)) throw new DomainError(`没有名为「${from}」的领域`, 404);

  const moved = countTerms(from, ownerId);
  const targetExisted = getDomainRow(to, ownerId) !== null;

  // 步骤 1：迁词条（事实层）。有词条才调——tidy.renameDomain 拿词条行当存在性凭证，
  // 空领域传进去会直接报「没有名为 X 的领域」（v19 之前领域建不出来也正因为这条）。
  if (moved > 0) {
    const r = renameDomain(from, to, ownerId);
    if (r.result === 'error') throw new DomainError(r.message ?? '领域改名失败', 409);
  }

  // 步骤 2：同步登记册（索引层）。目标已存在 ⇒ 合一（删旧名、留目标行及其 note）。
  // ★ 两条路径都带 owner：改别人的登记册行是**跨用户篡改**，而 `name` 在归主后已不唯一
  //   （A、B 各可有一个 `math`）⇒ 只按 name 定位会同时改掉所有人的同名域。
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const tx = db.transaction(() => {
    if (targetExisted) db.prepare('DELETE FROM term_domain WHERE owner_id = ? AND name = ?').run(owner, from);
    else
      db.prepare(`UPDATE term_domain SET name = ?, updated_at = datetime('now') WHERE owner_id = ? AND name = ?`).run(
        to,
        owner,
        from,
      );
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
 * ★ 归主后「终点」是**该用户自己的** `general`：先 `ensureDefaultDomain` 保证它在，
 *   否则删完域会留下「词条指向登记册里不存在的领域」的态（Tab 靠孤儿域兜底仍显示，
 *   但不变式 `term_library.domain ⊆ term_domain.name` 已破）。
 */
export function removeDomain(rawName: string, ownerId: string | null): RemoveDomainResult {
  const name = normalizeDomainName(rawName);
  if (!name) throw new DomainError('领域名不能为空');
  if (!getDomainRow(name, ownerId)) throw new DomainError(`没有名为「${name}」的领域`, 404);
  if (name === DEFAULT_DOMAIN) throw new DomainError(`「${DEFAULT_DOMAIN}」是默认领域，不能删除`, 409);

  ensureDefaultDomain(ownerId);
  const moved = countTerms(name, ownerId);
  if (moved > 0) {
    const r = renameDomain(name, DEFAULT_DOMAIN, ownerId);
    if (r.result === 'error') throw new DomainError(r.message ?? '词条迁移失败', 409);
  }
  getDb()
    .prepare('DELETE FROM term_domain WHERE owner_id = ? AND name = ?')
    .run(ownerForWrite(ownerId), name);
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
 *
 * ★ **两条支路都要按人算**（归主后本函数最危险的写法是只改一条）：
 *   支路一 `d.owner_id = ?`；支路二 `t.owner_id = ?`。★ 且**两处 JOIN 都要
 *   `AND t.owner_id = d.owner_id`**——只按 name 连会把 A 的领域行与 B 的同名词条连起来，
 *   A 的 count 里混进 B 的词条而两人都看不出异常（见文件头）。
 */
export function domainStats(ownerId: string | null): {
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
  // ★ 读路径补建（老板 2026-09-18 拍板）：新用户打开 Tab 恒有一格 general，与归主前观感一致。
  ensureDefaultDomain(ownerId);
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const total = (
    db.prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ?').get(owner) as { c: number }
  ).c;
  const domains = db
    .prepare(
      `SELECT d.name AS domain, d.note AS note, d.review_enabled AS review_enabled, COUNT(t.id) AS count,
              COALESCE(SUM(${SCOPE_FLAG}), 0) AS review_count
         FROM term_domain d LEFT JOIN term_library t ON t.domain = d.name AND t.owner_id = d.owner_id
        WHERE d.owner_id = ?
        GROUP BY d.name, d.note, d.review_enabled
        UNION ALL
       SELECT t.domain AS domain, '' AS note, 0 AS review_enabled, COUNT(*) AS count,
              COALESCE(SUM(${SCOPE_FLAG}), 0) AS review_count
         FROM term_library t LEFT JOIN term_domain d ON d.name = t.domain AND d.owner_id = t.owner_id
        WHERE d.name IS NULL AND t.owner_id = ?
        GROUP BY t.domain
        ORDER BY count DESC, domain ASC`,
    )
    .all(owner, owner) as Array<{ domain: string; count: number; note: string; review_enabled: number; review_count: number }>;
  const today = (
    db.prepare("SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ? AND created_at >= date('now')").get(owner) as {
      c: number;
    }
  ).c;

  // ★ 提及口径不在这里重写 SQL：一律向 `mention.ts` 要（那里的 `domainMentionTotals` 是唯一实现）。
  //   本文件自己写一遍 `SUM(usage_count)` 就会有两份口径，将来加归属过滤时必漏一边
  //   ——M2d-2 这次正是按这条走的：归属只加在 `mention.ts` 一处，本文件传参即可。
  const mentions = domainMentionTotals(ownerId);
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
