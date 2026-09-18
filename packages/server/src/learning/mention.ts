/**
 * learning/mention — 词条提及流水（契约 `docs/MEMORY-TREND-SPEC.md` §1）。
 *
 * ★ 为什么需要这个文件：`countUsage` 原来只把命中的词条 `usage_count + 1`，那是个
 *   **累加值**——它能回答「一共提了多少次」，回答不了「**什么时候**提的」。
 *   而「近期学习趋势 / 领域提及数 / 画像按使用次数加权」三件事全是**时间维度**的，
 *   没有逐次记录就**算不出来**（不是实现难，是数据不存在）。
 *   故本模块是整条联动链的地基：一次提及同时喂给领域统计、长期记忆、督促趋势三处。
 *
 * ★ **本文件不开事务**：唯一的写入调用方是 `terms.ts` 的 `countUsage`，
 *   那里已经把「UPDATE 计数」与「INSERT 流水」包在同一个事务里（契约 §1.4）——
 *   两处必须原子，否则会出现「计数加了、流水没落」的分叉，差值此后再也无法对齐。
 *   而 better-sqlite3 嵌套 `transaction()` 会抛 `cannot start a transaction within
 *   a transaction`，故这里只做 `prepare` + `run`，事务边界交给调用方。
 *
 * ★ **两个口径永久并存、不可互相校验**（契约 §1.5，这是本批最容易误读的地方）：
 *   · `domainMentionTotals()` 走 `usage_count` 聚合 —— **含流水建表前的全部历史**；
 *   · `mentionTrend()` 走流水表 —— **只覆盖建表之后**。
 *   历史提及没有时间信息，按当前时间批量补行就是**造假数据**（会让趋势图显示一批
 *   用户根本没发生过的"提及"）⇒ 宁可从零开始积累，也不伪造历史。
 *
 * ── M2d-2（v31，2026-09-18）：本文件全量归主 ───────────────────────────────────
 *
 * ★ **四处都要改，漏一处就是一个静默的跨用户泄露**（本批真正的风险点）：
 *   ① `recordMentions` 写侧——原样把 `null` 写进 `owner_id`（列当时可空）⇒ 未登录的流水
 *      记成 `NULL`，而登录用户的读侧查 `''`，两边**永远对不上**；改 `ownerForWrite` 后
 *      与 v31 迁移的口径对齐（`term_mention_log.owner_id` 已由可空改 `NOT NULL DEFAULT ''`）。
 *   ② `mentionTrend` 的三个查询——原来用 `ownerFilter`（`null` ⇒ **不加条件**）⇒
 *      未登录请求的聚合会**把全站所有用户的提及加在一起**（契约 §8.2 点名的那条）。
 *      本文件的读形状是**聚合**（`COUNT(*)` / `SUM`）⇒ 按 M2d-1 判据一律走 `ownerForWrite`。
 *   ③ `domainMentionTotals` —— `term_library` 归主后**必须带归属**，否则 A 的领域榜
 *      把 B 的 `usage_count` 一起算进去（这个数还会流进 `domains.domainStats().preferred`）。
 *   ④ `topMentionedTerms` —— 同上，长期记忆的偏好画像不能取到别人的高频词条。
 *
 * ★ `ownerId` **必填、不给默认值**：默认值会让"漏传"退化成"按未登录处理"，
 *   而漏传的表现是**静默串台**（读到别人的流水）或**静默丢写**（写进无主行）。
 *   签名强制传入，`tsc` 会把每个调用点逐一点名。
 */
import { randomUUID } from 'node:crypto';
import { localDayKey } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/** 趋势默认窗口（天）。UI 标题**必须**显示这个数——流水不含历史，不能写成"总趋势" */
export const MENTION_WINDOW_DAYS = 7;
/** 榜单条数上限（领域榜 / 词条榜各取前 N） */
export const MENTION_TOP_LIMIT = 5;

/** 一次提及要落的最小事实：哪个词条、**当时**属于哪个领域 */
export interface MentionInput {
  termId: string;
  /**
   * ★ 这是**快照**，不是外键（契约 §1.3a）：词条可以被改领域、也可以被删除，
   *   若只存 `term_id` 再 JOIN 取领域，那么"三个月前属于算法、今天被挪到网络"的词条
   *   会让**历史趋势整体漂移**——同一张图昨天看是"算法涨了"、今天变成"网络涨了"，
   *   而用户什么都没做。流水是历史事实，事实必须当场冻结。
   */
  domain: string;
}

/** `YYYY-MM-DD HH:MM:SS`（UTC，与 SQLite `datetime('now')` 同形，本仓各表同口径） */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 落流水（**调用方负责事务**，见文件头）。
 * `now` 可注入：跨天/跨窗口的边界只有把"现在"变成参数才测得了。
 */
export function recordMentions(
  rows: MentionInput[],
  ownerId: string | null,
  now: Date = new Date(),
): number {
  if (rows.length === 0) return 0;
  const stmt = getDb().prepare(
    `INSERT INTO term_mention_log (id, term_id, domain, owner_id, mentioned_at, mentioned_day)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // ★ 时刻存 UTC 文本、日历日存**本地**键：两者刻意不同源（契约 §1.3c）。
  //   前者用于"上次提及在几点"，后者用于按天聚合——混用会在 +8 区晚上错一天。
  const at = sqliteUtc(now);
  const day = localDayKey(now);
  // ★ 写侧落 `''`（无主行）而不是 `null`：与 v31 迁移把列改成 `NOT NULL DEFAULT ''` 同口径。
  const owner = ownerForWrite(ownerId);
  for (const r of rows) stmt.run(randomUUID(), r.termId, r.domain, owner, at, day);
  return rows.length;
}

/** 最近 `days` 天的本地日历日键（升序，末位 = 今天）——**含今天**，否则"近 7 天"只有 6 天 */
function recentDayKeys(days: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return out;
}

/** 窗口趋势（契约 §4.1 的卡片数据形状；纯数据，前端再转成 SVG） */
export interface MentionTrend {
  days: number;
  /** 横轴：本地日历日 `MM-DD`（与 `values` 等长、严格升序） */
  labels: string[];
  /** 每天的总提及次数（无提及的日期补 0，**不允许缺格**——缺格会让折线错位） */
  values: number[];
  /** 窗口内总提及数 */
  total: number;
  /** 窗口内提及最多的领域（降序） */
  topDomains: Array<{ domain: string; count: number }>;
  /** 窗口内提及最多的词条（降序） */
  topTerms: Array<{ term: string; count: number }>;
}

/**
 * 按窗口聚合提及流水。
 *
 * ★ 日期序列由 JS 生成、而不是靠 SQL 补零：SQL 里没有"生成日期序列"的干净写法
 *   （要递归 CTE），而**缺格比缺数据更难查**——折线图少一格会整体左移一天。
 */
export function mentionTrend(
  days: number,
  ownerId: string | null,
  now: Date = new Date(),
): MentionTrend {
  const n = Math.min(Math.max(Math.trunc(days) || MENTION_WINDOW_DAYS, 1), 90);
  const labels = recentDayKeys(n, now);
  const from = labels[0] ?? localDayKey(now);
  const db = getDb();
  const owner = ownerForWrite(ownerId);

  const byDay = db
    .prepare(
      `SELECT mentioned_day AS day, COUNT(*) AS c FROM term_mention_log
        WHERE mentioned_day >= ? AND owner_id = ? GROUP BY mentioned_day`,
    )
    .all(from, owner) as Array<{ day: string; c: number }>;
  const counts = new Map(byDay.map((r) => [r.day, r.c]));
  const values = labels.map((k) => counts.get(k) ?? 0);

  const topDomains = db
    .prepare(
      `SELECT domain, COUNT(*) AS count FROM term_mention_log
        WHERE mentioned_day >= ? AND owner_id = ? GROUP BY domain
        ORDER BY count DESC, domain ASC LIMIT ?`,
    )
    .all(from, owner, MENTION_TOP_LIMIT) as Array<{ domain: string; count: number }>;

  // ★ 词条名要回 `term_library` 取（流水只存 term_id）⇒ 走 INNER JOIN，
  //   **已删除的词条不进榜**；但它仍计入 `total`（流水是历史事实，不随词条存亡而消失，契约 §6.2）。
  // ★ 两侧都带归属：`m.owner_id` 挡流水、`t.owner_id` 挡词条。只挡一侧的话，
  //   一条 `owner_id=''` 的遗留流水挂在某个用户的词条上时仍会进榜（无主行不该对登录用户可见）。
  const topTerms = db
    .prepare(
      `SELECT t.term AS term, COUNT(*) AS count FROM term_mention_log m
         JOIN term_library t ON t.id = m.term_id
        WHERE m.mentioned_day >= ? AND m.owner_id = ? AND t.owner_id = ?
        GROUP BY t.term ORDER BY count DESC, term ASC LIMIT ?`,
    )
    .all(from, owner, owner, MENTION_TOP_LIMIT) as Array<{ term: string; count: number }>;

  return { days: n, labels, values, total: values.reduce((a, b) => a + b, 0), topDomains, topTerms };
}

/**
 * 各领域的**总**提及数 = 该领域内所有词条的 `usage_count` 之和。
 *
 * ★ 走 `usage_count` 聚合而**不是**流水表：这是「**总**」口径，**含流水建表之前的全部历史**
 *   （契约 §1.5）。两个口径**永久并存、不可互相校验**——历史提及没有任何时间信息，
 *   无法回溯成流水行。故「领域总提及数」与「领域近期提及数」是两个不同的数，别互相验证。
 * ★ **v31 起按人算**：`term_library` 已归主，本函数**必须**带归属——否则 A 的领域榜会把
 *   B 的 `usage_count` 一起加进来（该数还会流进 `domains.domainStats().preferred`）。
 * ★ 提及口径在这里**只有这一份实现**：`domains.ts` 的 `domainStats()` 不自己写
 *   `SUM(usage_count)`，一律向本函数要 Map——否则「总提及数」会有两份 SQL，迟早漂。
 */
export function domainMentionTotals(ownerId: string | null): Map<string, number> {
  const rows = getDb()
    .prepare('SELECT domain, SUM(usage_count) AS c FROM term_library WHERE owner_id = ? GROUP BY domain')
    .all(ownerForWrite(ownerId)) as Array<{ domain: string; c: number | null }>;
  return new Map(rows.map((r) => [r.domain, r.c ?? 0]));
}

/**
 * 高频词条榜（**总**口径，与 `domainMentionTotals` 同源：两者都走 `usage_count`，
 * 都**含流水建表前的全部历史**）。供长期记忆的偏好画像取 top N（契约 §3.2）。
 *
 * ★ `WHERE usage_count > 0` 不是性能优化，是**语义**：一次都没提过的词条不构成偏好，
 *   列出来只会把真正的偏好稀释掉。这条与 `domains.preferred` 的「只含 >0」是同一条规矩。
 * ★ 排序给到 `term ASC` 二级键 ⇒ **全序**，同一份数据每次返回顺序逐字相同
 *   （否则 `LIMIT` 在并列处取谁是不确定的，画像就成了随机内容）。
 */
export function topMentionedTerms(ownerId: string | null, limit: number = MENTION_TOP_LIMIT): Array<{ term: string; count: number }> {
  const n = Math.min(Math.max(Math.trunc(limit) || MENTION_TOP_LIMIT, 1), 50);
  return getDb()
    .prepare(
      `SELECT term, usage_count AS count FROM term_library
        WHERE usage_count > 0 AND owner_id = ?
        ORDER BY usage_count DESC, term ASC LIMIT ?`,
    )
    .all(ownerForWrite(ownerId), n) as Array<{ term: string; count: number }>;
}

/** 横轴标签用：`YYYY-MM-DD` → `MM-DD`（图表横轴塞不下年份，年份在标题的窗口里已表达） */
export function shortDayLabel(key: string): string {
  return /^\d{4}-(\d{2}-\d{2})$/.exec(key)?.[1] ?? key;
}
