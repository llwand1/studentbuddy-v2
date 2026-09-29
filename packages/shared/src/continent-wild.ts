/**
 * shared/continent-wild — 知识大陆的**野怪**（2026-09-29，契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「刷怪」）。
 *
 * ── 为什么要有第二种刷怪 ──────────────────────────────────────────────────────
 * 原口径只有一种怪：「**欠账怪**」= 复习范围内、到期/逾期的词条（`monsterOccupies`）。它是对的——
 * 怪就是你欠的复习——但它有个盲区：**新用户一只怪也看不到**。新词条明天才到期，而领域默认
 * 不在复习范围（v28「选择式复习」），于是第一天的大陆是一片安静的空地，"打怪收复"这条主线
 * 根本没机会被看见。产品结论：**多种刷怪方式并存**——欠账怪照旧，另加**野怪**保底。
 *
 * ── 野怪的口径（全部派生、零存储、零随机源）────────────────────────────────────
 *   · **每天一批**：按 `(dayKey, 词条 id)` 的稳定哈希给全部词条排名，取前 `wildMonsterCountFor(n)` 条
 *     作为"今天的野怪位"。同一天怎么刷新都是同几只；换一天换一批——这就是"随机刷怪"，
 *     但随机源是日历，不是 `Math.random`（本文件与 `continent.ts` 同一条纪律：不读时钟，
 *     `dayKey` 由调用方传进来）。
 *   · **野怪位上不是每只都出场**：那条词条**今天已经复习过** ⇒ 不出（打赢它的唯一后果就是
 *     `last_reviewed_at = 今天`，于是它自己消失——不需要任何"已击杀"状态位）；
 *     它本身就是欠账怪 ⇒ 不重复出（欠账怪优先，两种怪不会叠在一格）。
 *   · **不看复习范围**：范围外的词条也会出野怪——这正是新用户能看到怪的原因。打赢范围外的野怪
 *     ⇒ 前端先把它纳入复习范围再打卡（`scopeTerm` + `mark`），弹窗里会提前说清楚。
 *   · **不占领地**：野怪只站本体那一格。领地是"欠了多久"的可见形状，野怪没欠账，不该吞地。
 *   · 等级/怪种与欠账怪同一套派生（`monsterLevel(stage)` / `speciesTypes(id)`）⇒ 图鉴口径不变。
 *   · **不进伙伴的扫描**（server `npc-map.ts`）：伙伴的落位 / 遇险 / 求救单只认欠账怪——野怪每天换一批，
 *     让它牵动伙伴的处境会变成"求救单随日历自动完成、白发钥匙"，且新用户第一条词条会没地方安置伙伴。
 *
 * ★ 数量：`1 + floor(n / 8)`，夹到 `[1, 8]`（n = 词条总数；n = 0 ⇒ 0）。一条词条也要有一只
 *   ——新用户第一条词条存进去，大陆上就该有东西可打。
 */
import { continentHash, monsterOccupies } from './continent.js';
import type { ReviewBasis, ReviewStatus } from './ebbinghaus.js';

/** 怪的来路：欠账怪（到期/逾期，占地）／野怪（每日随机保底，不占地） */
export type ContinentMonsterKind = 'due' | 'wild';

/** 野怪上限（一屏 14×10，再多就成了怪比地多） */
export const WILD_MONSTER_MAX = 8;
/** 每多少条词条多一只野怪 */
export const WILD_MONSTER_PER_TERMS = 8;

/** 刷野怪只要求这几个字段（server 的 `ContinentMapTerm` 与 web 的同名类型都满足） */
export interface ContinentSpawnTerm {
  id: string;
  review_in_scope: number;
  review: { status: ReviewStatus; basis: ReviewBasis; daysSince: number };
}

/** 今天应有几只野怪位 */
export function wildMonsterCountFor(termCount: number): number {
  const n = Math.max(0, Math.trunc(termCount) || 0);
  if (n === 0) return 0;
  return Math.min(1 + Math.floor(n / WILD_MONSTER_PER_TERMS), WILD_MONSTER_MAX);
}

/** 今天复习过（`basis === 'review'` 且距上次复习 0 天；刚入库的词条 `basis === 'created'`，不算） */
export function reviewedToday(review: { basis: ReviewBasis; daysSince: number }): boolean {
  return review.basis === 'review' && review.daysSince === 0;
}

/** 这条词条今天能不能当野怪出场（见头注：不是欠账怪、今天没复习过） */
export function wildEligible(t: ContinentSpawnTerm): boolean {
  return !monsterOccupies(t.review.status, t.review_in_scope === 1) && !reviewedToday(t.review);
}

/**
 * 今天的野怪（词条 id 集合）。`dayKey` = 本地日历日 `YYYY-MM-DD`（调用方用 `localDayKey(new Date())` 取）。
 * ★ 排名对**全部**词条做，再筛出场资格：这样"打赢一只"不会让下一名顶上来（那会变成无限刷），
 *   今天的野怪位打完就是打完了，明天再来一批。
 */
export function wildMonsterIds(terms: readonly ContinentSpawnTerm[], dayKey: string): Set<string> {
  const quota = wildMonsterCountFor(terms.length);
  if (quota === 0) return new Set();
  const ranked = terms
    .map((t) => ({ t, k: continentHash(`wild|${dayKey}|${t.id}`) }))
    .sort((a, b) => (a.k === b.k ? (a.t.id < b.t.id ? -1 : 1) : a.k - b.k))
    .slice(0, quota);
  return new Set(ranked.filter((x) => wildEligible(x.t)).map((x) => x.t.id));
}

/** 某格的怪是哪一种（没怪 ⇒ `null`）；欠账怪优先 */
export function monsterKindOf(t: ContinentSpawnTerm, wild: ReadonlySet<string>): ContinentMonsterKind | null {
  if (monsterOccupies(t.review.status, t.review_in_scope === 1)) return 'due';
  return wild.has(t.id) ? 'wild' : null;
}
