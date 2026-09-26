/**
 * learning/term-cards — 词条卡牌数的**派生读口**（2026-09-25 新建，契约 `docs/TERM-CARDS-SPEC.md` §1）。
 *
 * ★★ 本文件**没有任何写入口**，这是设计而不是遗漏。卡数定义为**三张流水**的计数：
 *
 *     cards(term) = COUNT(该词条的提及流水行)
 *                 + COUNT(该词条的**不同复习日**)
 *                 + COUNT(该词条被宝箱**收下**的次数)
 *                 + 1（建卡那张，见下方口径 3）
 *
 *   ★ 宝箱为什么进加数而不是另开一列：用户拍板"抽到的要是新词"，那抽中并收下本身就是一次
 *   **真实的接触事件**，它和提及／复习同级。而 `chest_open` 已经是一行一次的流水了
 *   （它必须存在，否则"抽到但没要"无处表达），所以数它 = 派生，**不违反边界①**；
 *   反过来若给它单独加一个 `bonus_cards` 列，就出现了"有计数、无流水"那个本仓反复拒绝的形状。
 *   ⇒ 直接后果：**从宝箱收下的词条天生 ★1**（1 建卡 + 1 宝箱 = 2 张）。这条不是装饰，
 *   它是"宝箱给的是奖励而不是一个重复劳动"的唯一诚实实现——不给，抽到的卡和手动添加的卡
 *   完全等价，那这个玩法就没有奖励可言。
 *
 *   为什么不落一张 `cards` 列／`term_card` 表（契约 §1 的论证，改码前必读）：
 *   `term_mention_log` 与 `term_review_log` 本来就是**一行一个真实事件**，卡数只是它们的读数。
 *   再存一份 = 同一个事实两个落点——`learning/mention.ts` 文件头那条
 *   「计数加了、流水没落 ⇒ 差值此后再也无法对齐」在这里**反过来同样成立**：
 *   派生值一旦落库，任何一次补录／删词条／改流水都会造出没人能校验的分叉。
 *   而词条量级 ≤500（`listTerms` 的 LIMIT），一次聚合全算出来比维护计数表**既准又便宜**
 *   ——与 `term-review.ts` 文件头「库里只存两个真值，下次什么时候复习每次现算」同一条判据。
 *
 * 四条口径：
 *  1. **不读 `usage_count`**。它是「**总**提及」口径，含流水建表之前的全部历史，而那部分
 *     **没有时间信息**（`mention.ts` §1.5 明令两个口径永久并存、不可互相校验，并拒绝为历史补行）。
 *     拿它当卡数＝把"历史提及"伪装成"逐次事件"。⇒ 老用户会看到「提及 20 次、卡数 8 张」，
 *     差值就是建表前那部分。UI 必须能自解释，所以本文件同时给 `logSince`（契约 §7.4）。
 *  2. **提及侧按行数、复习侧按不同日**。复习不能数行：`markReviewed` 明确允许同日重复打卡
 *     且**每次都写流水**（`EBBINGHAUS-SPEC §10.5` 的「同日只推进一次」闸门只管曲线不管流水）。
 *     直接 `COUNT(*)` 会让"一天把一条刷 10 遍"灌出 10 张卡。⇒ `COUNT(DISTINCT reviewed_day)`，
 *     **判据与那条闸门同源**：一天之内同一条词条的复习只贡献一张卡。
 *  3. **建卡那张（`+1`）不是奖励，是补一个读数缺口**：用户亲手把词条记进库里本身就是一次真实
 *     接触，而它既不产生提及流水也不产生复习流水。不给这一张，则全库最低的词条永远 0 卡——
 *     "我记下来的词一张卡都没有"是错的读数。
 *  4. **宝箱侧按「收下」的次数**，`accepted = 0` 的那些行**不计**：抽中但走掉不是一次接触，
 *     给它记账等于奖励"没发生的动作"。所以宝箱只有一枚卡、且必须点收下才落。
 *
 * ★ 归属：两张表的归主方式**不同**，别照抄。`term_mention_log` **有** `owner_id`（v31 建）；
 *   `term_review_log` **没有**（v22 建、v31 刻意不给，理由见 `term-review.ts` 文件头
 *   「归属只有一处可表达」⇒ 由 `term_id` 连接带出）。所以下面复习侧的连接**不写 owner
 *   条件不是遗漏**：先按 `t.owner_id = ?` 选出词条集，流水行只能通过连接归属到同一批词条。
 *   ⚠️ 但提及侧**必须**带 `m.owner_id = t.owner_id`：v31 给这列落了 `NOT NULL DEFAULT ''`，
 *   而归主之前写下的行就是 `''`（本机老数据里存在）——漏了这个条件等于把无主行的流水
 *   算进登录用户的卡数（`countUsage` 那条"归主之后漏传就是串台"同款）。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { starOf, rarityOf, nextStarProgress, CARD_STAR_CAP, type CardRarity } from '@sb/shared';

/** 一条词条的卡牌读数（全部派生，无一行存在库里） */
export interface TermCards {
  termId: string;
  /** 提及流水条数（契约口径 1） */
  mentions: number;
  /** **不同**复习日数（口径 2：同日只一张） */
  reviewDays: number;
  /** 宝箱收下次数（口径 4：`accepted = 1` 才算） */
  chestGrants: number;
  /** 合计卡数 = mentions + reviewDays + chestGrants + 1 */
  cards: number;
  /** ★0..★8（`shared/term-cards.ts` 的 `starOf`，本文件不重算） */
  star: number;
  /** 距下一星：还差几张、已完成比例（封顶时 needed 为 null） */
  progress: ReturnType<typeof nextStarProgress>;
  rarity: CardRarity;
}

/**
 * 全库卡牌读数，**一次聚合算完**（列表页与 `/state` 都用它）。
 *
 * ★ 为什么用相关子查询而不是三条 `GROUP BY` 再 JOIN：本函数的结果要贴到
 *   `listTerms` 已经排好序、过滤好的那 500 行上。三条聚合各自全表 group 再拼 Map，
 *   在"只看了某个领域"时仍会算完整库；相关子查询由三个既有索引吃掉了
 *   （`idx_term_mention_term(owner_id, term_id)`／`idx_term_review_log_term(term_id)`／
 *   v45 的 `ix_chest_open_term(owner_id, term_id)`——第三张是本次新建的表，索引随表一起建，
 *   **没有为卡牌另加索引**，加索引才是需要论证的改动）。
 * ★ 没有任何流水的词条也会出一行（子查询回 0）⇒ 卡数恒 ≥1，见口径 3。
 */
export function cardsByTerm(ownerId: string | null): Map<string, TermCards> {
  const owner = ownerForWrite(ownerId);
  const rows = getDb()
    .prepare(
      `SELECT t.id AS term_id,
              (SELECT COUNT(*) FROM term_mention_log m
                WHERE m.term_id = t.id AND m.owner_id = t.owner_id) AS mentions,
              (SELECT COUNT(DISTINCT l.reviewed_day) FROM term_review_log l
                WHERE l.term_id = t.id) AS review_days,
              (SELECT COUNT(*) FROM chest_open c
                WHERE c.term_id = t.id AND c.owner_id = t.owner_id AND c.accepted = 1) AS chest_grants
         FROM term_library t
        WHERE t.owner_id = ?`,
    )
    .all(owner) as Array<{ term_id: string; mentions: number; review_days: number; chest_grants: number }>;

  const out = new Map<string, TermCards>();
  for (const r of rows) out.set(r.term_id, toCards(r.term_id, r.mentions, r.review_days, r.chest_grants));
  return out;
}

/** 单条词条的卡牌读数；词条不属该 owner 时返回 null（★ 归属由这条 `EXISTS` 挡，见文件头） */
export function termCards(termId: string, ownerId: string | null): TermCards | null {
  const owner = ownerForWrite(ownerId);
  const row = getDb()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM term_mention_log m
           WHERE m.term_id = t.id AND m.owner_id = t.owner_id) AS mentions,
         (SELECT COUNT(DISTINCT l.reviewed_day) FROM term_review_log l
           WHERE l.term_id = t.id) AS review_days,
         (SELECT COUNT(*) FROM chest_open c
           WHERE c.term_id = t.id AND c.owner_id = t.owner_id AND c.accepted = 1) AS chest_grants
         FROM term_library t
        WHERE t.id = ? AND t.owner_id = ?`,
    )
    .get(termId, owner) as { mentions: number; review_days: number; chest_grants: number } | undefined;
  if (!row) return null;
  return toCards(termId, row.mentions, row.review_days, row.chest_grants);
}

/** 行 → 读数。**星与稀有度一律向 `@sb/shared` 要**（口径双写 = 「列表 ★2、派单说还差 3 张」） */
function toCards(termId: string, mentions: number, reviewDays: number, chestGrants: number): TermCards {
  const cards = mentions + reviewDays + chestGrants + 1;
  return {
    termId,
    mentions,
    reviewDays,
    chestGrants,
    cards,
    star: starOf(cards),
    progress: nextStarProgress(cards),
    rarity: rarityOf(cards),
  };
}

/**
 * 卡牌统计的**起点日**（本地日历日 `YYYY-MM-DD`），两侧流水取更早的一个；一条流水都没有 ⇒ null。
 *
 * ★ 这个数必须一路带到 UI（契约 §7.4）：口径 1 决定了「`usage_count` 20、卡数 8」是**正常现象**，
 *   用户看到就会以为在少算。把它变成一句能自解释的话（「卡牌统计自 2026-09-16」）
 *   比把它抹平要诚实得多——抹平的手段只有两种，要么读 `usage_count`（造假：把无时间信息的历史
 *   伪装成逐次事件），要么给历史补行（`mention.ts` 已明确拒绝过一次）。
 */
export function cardsLogSince(ownerId: string | null): string | null {
  const owner = ownerForWrite(ownerId);
  const row = getDb()
    .prepare(
      `SELECT MIN(day) AS since FROM (
         SELECT mentioned_day AS day FROM term_mention_log WHERE owner_id = ?
         UNION ALL
         SELECT l.reviewed_day AS day FROM term_review_log l
           JOIN term_library t ON t.id = l.term_id
          WHERE t.owner_id = ?
       )`,
    )
    .get(owner, owner) as { since: string | null } | undefined;
  return row?.since ?? null;
}

/** 卡墙顶部的那组汇总数（★ 全部由 `cardsByTerm` 派生，不另开一条 SQL——两处算法会漂） */
export interface CardWallSummary {
  totalTerms: number;
  totalCards: number;
  /** 下标即星级的词条数（长度 = ★8+1） */
  byStar: number[];
  byRarity: Record<CardRarity, number>;
  /** 已有卡但离下一星 ≤20% 的条数——派单的第一优先来源（契约 §5 的「推进」意图） */
  almostThere: number;
}

export function cardWallSummary(ownerId: string | null): CardWallSummary {
  return summarizeCards([...cardsByTerm(ownerId).values()]);
}

/**
 * 汇总的**纯计算**那一半：入参是已经算好的读数，不再碰库。
 * ★ 为什么拆开：`GET /state` 本来就要为卡墙跑一次 `cardsByTerm`，若继续调
 *   `cardWallSummary(ownerId)` 就是**同一份三子查询聚合跑两遍**（≤500 条词条，每次三条相关子查询）。
 *   合上的代价是"两处各数一遍会漂"，所以这里保留唯一的数法，只是让它能吃现成的输入。
 */
export function summarizeCards(cards: readonly TermCards[]): CardWallSummary {
  const byStar = new Array<number>(CARD_STAR_CAP + 1).fill(0);
  const byRarity: Record<CardRarity, number> = { N: 0, R: 0, SR: 0, SSR: 0 };
  let totalCards = 0;
  let almostThere = 0;
  for (const c of cards) {
    const idx = Math.min(c.star, byStar.length - 1);
    byStar[idx] = (byStar[idx] ?? 0) + 1;
    byRarity[c.rarity] = (byRarity[c.rarity] ?? 0) + 1;
    totalCards += c.cards;
    if (c.progress.needed !== null && c.progress.needed <= 2 && c.progress.pct >= 0.6) almostThere += 1;
  }
  return { totalTerms: cards.length, totalCards, byStar, byRarity, almostThere };
}
