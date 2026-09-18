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
 */
import { randomUUID } from 'node:crypto';
import { localDayKey } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerFilter } from '../auth/ownership.js';

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
  ownerId: string | null = null,
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
  for (const r of rows) stmt.run(randomUUID(), r.termId, r.domain, ownerId, at, day);
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
  days: number = MENTION_WINDOW_DAYS,
  ownerId: string | null = null,
  now: Date = new Date(),
): MentionTrend {
  const n = Math.min(Math.max(Math.trunc(days) || MENTION_WINDOW_DAYS, 1), 90);
  const labels = recentDayKeys(n, now);
  const from = labels[0] ?? localDayKey(now);
  const db = getDb();
  const f = ownerFilter(ownerId, 'owner_id');

  const byDay = db
    .prepare(
      `SELECT mentioned_day AS day, COUNT(*) AS c FROM term_mention_log
        WHERE mentioned_day >= ?${f.sql} GROUP BY mentioned_day`,
    )
    .all(from, ...f.params) as Array<{ day: string; c: number }>;
  const counts = new Map(byDay.map((r) => [r.day, r.c]));
  const values = labels.map((k) => counts.get(k) ?? 0);

  const topDomains = db
    .prepare(
      `SELECT domain, COUNT(*) AS count FROM term_mention_log
        WHERE mentioned_day >= ?${f.sql} GROUP BY domain
        ORDER BY count DESC, domain ASC LIMIT ?`,
    )
    .all(from, ...f.params, MENTION_TOP_LIMIT) as Array<{ domain: string; count: number }>;

  // ★ 词条名要回 `term_library` 取（流水只存 term_id）⇒ 走 INNER JOIN，
  //   **已删除的词条不进榜**；但它仍计入 `total`（流水是历史事实，不随词条存亡而消失，契约 §6.2）。
  const ft = ownerFilter(ownerId, 'm.owner_id');
  const topTerms = db
    .prepare(
      `SELECT t.term AS term, COUNT(*) AS count FROM term_mention_log m
         JOIN term_library t ON t.id = m.term_id
        WHERE m.mentioned_day >= ?${ft.sql}
        GROUP BY t.term ORDER BY count DESC, term ASC LIMIT ?`,
    )
    .all(from, ...ft.params, MENTION_TOP_LIMIT) as Array<{ term: string; count: number }>;

  return { days: n, labels, values, total: values.reduce((a, b) => a + b, 0), topDomains, topTerms };
}

/** 横轴标签用：`YYYY-MM-DD` → `MM-DD`（图表横轴塞不下年份，年份在标题的窗口里已表达） */
export function shortDayLabel(key: string): string {
  return /^\d{4}-(\d{2}-\d{2})$/.exec(key)?.[1] ?? key;
}
