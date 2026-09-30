/**
 * shared/continent-upkeep — 知识大陆的**地块维护**与**话题怪**（2026-09-30，契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md`
 * §「地块维护」§「话题怪」）。两条口径都是**派生、零存储、不读时钟**（`dayKey` 由调用方传）。
 *
 * ── 一、地块维护：越靠边碎得越快 ────────────────────────────────────────────────
 * 用户反馈：大陆"太大不好"——三百多条词条铺成半径 9 的世界，绝大多数格子既没人看也没人管。
 * 结论不是砍词条（词条永远不删），而是让**地块要维护**：每块地有一个**耐久期**（天），多久没碰
 * （`review.daysSince`）超过耐久期就**原地碎成废墟**；复习一次（打怪 / 词条页 / 刷词……任何写 `last_reviewed_at`
 * 的路径）它就当场重建。耐久期由这格离中心的**环数** `max(|row|,|col|)` 决定：中心 120 天，越靠外越短，
 * 第 8 环起 7 天——最早学、最靠中心的知识最耐放，边缘新长出来的地得常回来看。
 *
 * ★ 为什么是**原地**碎而不是挤掉重排：伙伴的家（`npc_party.homeRow/homeCol`）与开拓钉子都是**存下来的坐标**
 *   ——"世界只增不减 ⇒ 坐标永不失效"是那两处能存坐标的前提。地块一挪位，伙伴就站到别人家去了。
 *   所以铺格（`layoutTiles`）一格不动，废墟只是地块的一种**状态**（`wear ≥ 1`），服务端的扫描与开拓口径都不用改。
 * ★ 为什么不设"64 块硬上限"：硬上限要挑"淘汰谁"，而任何淘汰规则都会在某天把用户刚学的那块地扔掉。
 *   按环数递减的耐久期让完好地块数**自然收敛**：环数 0–3（49 格）耐久 ≥ 45 天基本常在，环数 4（32 格）30 天
 *   看维护，再外面只剩最近碰过的——常态就是六七十块完好地 + 一圈会呼吸的边缘。
 * ★ 已入长期记忆（`status === 'mastered'`）的地块**不碎**：复习引擎已不再催它，大陆也不该在它头上唠叨；
 *   它是"基石"——把一条词条学到毕业，就换来一块永固的地。
 * ★ 废墟**不影响**怪的口径：欠账怪 / 野怪 / 话题怪该在哪格还在哪格（怪站在废墟上很合理——那正是要你回来的地方），
 *   领地扩散也照旧。废墟只改变三件事：不计入"完好地块"数、画成碎石、点它可以直接「复习重建」。
 *
 * ── 二、话题怪：对话里提到的词条今天冒怪 ───────────────────────────────────────
 * 用户提的刷怪新规律："用户在对话时刷新对应的怪物"。口径取最窄、最确定的一种：
 * **AI 这一轮的回复里提到了词库里的词条**（服务端 `term-usage.ts` 收口时按与正文高亮同一条匹配规则写
 * `term_library.last_used_at`）⇒ 那些词条**今天**冒「话题怪」。零新存储：`last_used_at` 早就在。
 *   · 今天（本地日历日）提到过 · 不是欠账怪（欠账怪优先，同格不叠） · 今天没复习过（打赢它＝复习一次 ⇒ 自己消失）；
 *   · 最多 `TOPIC_MONSTER_MAX` 只，取**最近提到**的（一轮回复点到二十个词条时不该刷出二十只）；
 *   · 不看复习范围（与野怪同：打赢范围外的先纳入再打卡）、不占领地、不牵动伙伴处境（与野怪同一理由）。
 */
import { monsterOccupies } from './continent.js';
import { reviewedToday, type ContinentSpawnTerm } from './continent-wild.js';
import { localDayKey, parseSqliteDate } from './ebbinghaus.js';

/** 各环的耐久期（天）：下标 = 环数 `max(|row|,|col|)`，超出末项按末项 */
export const CONTINENT_DURABILITY_DAYS: readonly number[] = [120, 90, 60, 45, 30, 21, 14, 10, 7];

/** 这格离中心几环（中心格 0；第 k 环共 8k 格） */
export function tileRing(cell: { row: number; col: number }): number {
  return Math.max(Math.abs(cell.row), Math.abs(cell.col));
}

/** 某一环地块的耐久期（天） */
export function tileDurabilityDays(ring: number): number {
  const i = Math.min(Math.max(Math.trunc(ring) || 0, 0), CONTINENT_DURABILITY_DAYS.length - 1);
  return CONTINENT_DURABILITY_DAYS[i] ?? 7;
}

/** 算磨损只要这两样 */
export interface ContinentWearTerm {
  review: { status: string; daysSince: number };
}

/**
 * 地块磨损度 `0..1`：`daysSince / 耐久期`，夹到 1；**1 = 废墟**。
 * 长期记忆（mastered）恒为 0（基石，见头注）。
 */
export function tileWear(t: ContinentWearTerm, cell: { row: number; col: number }): number {
  if (t.review.status === 'mastered') return 0;
  const days = Math.max(0, t.review.daysSince);
  return Math.min(1, days / tileDurabilityDays(tileRing(cell)));
}

/** 是不是废墟 */
export function isRuin(wear: number): boolean {
  return wear >= 1;
}

/** 磨损几档（渲染用）：0 完好 · 1 起裂（≥ 0.5）· 2 快碎（≥ 0.8）· 3 废墟 */
export function wearStage(wear: number): 0 | 1 | 2 | 3 {
  if (wear >= 1) return 3;
  if (wear >= 0.8) return 2;
  if (wear >= 0.5) return 1;
  return 0;
}

/** 话题怪上限 */
export const TOPIC_MONSTER_MAX = 6;

/** 刷话题怪需要的字段（`ContinentMapTerm` 两端都满足） */
export interface ContinentTopicTerm extends ContinentSpawnTerm {
  /** 最近一次在对话回复里被提到（SQLite UTC 文本）；没有 ⇒ `null`/缺省 */
  last_used_at?: string | null;
}

/** `last_used_at` 落在 `dayKey`（本地日历日）这一天 */
export function usedOnDay(lastUsedAt: string | null | undefined, dayKey: string): boolean {
  const d = parseSqliteDate(lastUsedAt);
  return d !== null && localDayKey(d) === dayKey;
}

/** 这条词条今天能不能当话题怪出场（今天提到过、不是欠账怪、今天没复习过） */
export function topicEligible(t: ContinentTopicTerm, dayKey: string): boolean {
  return usedOnDay(t.last_used_at, dayKey) && !monsterOccupies(t.review.status, t.review_in_scope === 1) && !reviewedToday(t.review);
}

/**
 * 今天的话题怪（词条 id 集合）：合格者按 `last_used_at` 新→旧（同刻按 id）取前 `TOPIC_MONSTER_MAX` 只。
 * ★ 与野怪不同，这里**先筛再截**：话题怪不是"每天固定几只"，而是"你刚聊到的那几条"，打掉一只不会顶上另一只
 *   ——只有再聊到新词条才会多出来。
 */
export function topicMonsterIds(terms: readonly ContinentTopicTerm[], dayKey: string): Set<string> {
  const picked = terms
    .filter((t) => topicEligible(t, dayKey))
    .sort((a, b) => {
      const ua = a.last_used_at ?? '';
      const ub = b.last_used_at ?? '';
      return ua === ub ? (a.id < b.id ? -1 : 1) : ua < ub ? 1 : -1;
    })
    .slice(0, TOPIC_MONSTER_MAX);
  return new Set(picked.map((t) => t.id));
}
