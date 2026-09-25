/**
 * auth/demo-seed — 公用体验账号的**首屏种子内容**（渠道台账 C5，契约 docs/AUTH-SPEC.md §2.10）。
 *
 * 要解决的问题：访客点「免注册直接体验」进来，看到的是一座**空库**——词条没有、复习队列
 * 没有、领域 Tab 也没有。这个产品的主体是词条，空态等于把「它到底干什么」藏起来了。
 *
 * ★★ 三条设计约束（改码前必读）：
 *   ① **只用真实领域函数写**（`saveOneTerm` ＋ `markReviewed`），不手写 `INSERT INTO term_library`。
 *      为什么这不是洁癖：真实路径顺带做了领域登记（v19 不变式 `词条.domain ⊆ term_domain`）、
 *      别名索引（`indexRow`，搜索与「同词并入」靠它）、UNIQUE 兜底与复习流水。绕开它就等于
 *      给体验号灌一份「看起来一样但少了一半关系」的假数据，而体验号的承诺是「和真账号同一种数据」。
 *   ② **时间不能伪造，只能推迟**：真实用户的历史是「隔了几天复习一次」长出来的，同一套状态
 *      在本仓无法用 `markReviewed` 连续调用得到（它有 v1.2 的「同日只推进一次」闸门，
 *      见 `learning/term-review.ts` 头注）。⇒ 每推进一级，就把**刚写的那条流水与 `last_reviewed_at`
 *      挪到按间隔表该在哪天**（`demoSeedBackdateDays` 与下面的偏移算式全部取自
 *      `REVIEW_INTERVALS_DAYS`，本文件不写任何天数常数）。这是「让时间过去」的等价物，不是造数据。
 *   ③ ⚠️ **只灌一次，且不碰已有内容**：库里该池已有**任何**词条就直接返回 0——先前灌过的、
 *      或真有访客存过的，一个字都不改（否则会把别人的学习记录当成演示素材覆盖掉）。
 *   ④ ⚠️ **必须把种子领域纳入复习范围**，否则队列永远是空的（这不是可选修饰，见
 *      `enableSeedDomains` 那一段的实测记录）。⇒ 本批在**体验号这一个账号**上把三个领域
 *      的复习开关打开；老板 2026-09-18 拍的「新领域默认全不选」在**其它账号上原样成立**。
 *
 * ★ 幂等所以可以挂在登录路径上：`demoLogin` 每次进入都调，成本是一条 `COUNT` 查询。
 * ★ 失败**不影响进应用**（catch ＋ warn）：种子是锦上添花，登录是承诺。
 */
import {
  DEMO_SEED_TERMS,
  DEMO_USER_ID,
  demoSeedBackdateDays,
  localDayKey,
  reviewIntervalDays,
  type DemoSeedTerm,
} from '@sb/shared';
import { markReviewed } from '../learning/term-review.js';
import { setDomainReviewScope } from '../learning/term-review-scope.js';
import { saveOneTerm } from '../learning/terms.js';
import { getDb } from '../storage/db.js';

const DAY_MS = 86_400_000;

/** 该池里是否已有任何词条（含访客真存过的）——有就绝不插手。 */
function poolAlreadyFilled(): boolean {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM term_library WHERE owner_id = ?')
    .get(DEMO_USER_ID) as { c: number };
  return row.c > 0;
}

/**
 * 把该词条**最新一条复习流水**与 `last_reviewed_at` 一起挪到 `daysAgo` 天前。
 * ★ 两处必须同一事务：只挪库里那一列的话，流水会说「今天复习过」而状态说「上次是 N 天前」——
 *   `markReviewed` 的同日闸门正是读流水的，两本账一分叉，再复习一次的行为就不可预期。
 */
function backdateLastReview(termId: string, daysAgo: number): void {
  const db = getDb();
  const day = localDayKey(new Date(Date.now() - daysAgo * DAY_MS));
  const mod = `-${daysAgo} days`;
  db.transaction(() => {
    const newest = db
      .prepare('SELECT id FROM term_review_log WHERE term_id = ? ORDER BY reviewed_at DESC, id DESC LIMIT 1')
      .get(termId) as { id: string } | undefined;
    if (newest) {
      db.prepare(`UPDATE term_review_log SET reviewed_day = ?, reviewed_at = datetime('now', ?) WHERE id = ?`).run(
        day,
        mod,
        newest.id,
      );
    }
    db.prepare(`UPDATE term_library SET last_reviewed_at = datetime('now', ?) WHERE id = ? AND owner_id = ?`).run(
      mod,
      termId,
      DEMO_USER_ID,
    );
  })();
}

/**
 * 第 `i` 次复习（共 `stage` 次）该落在几天前。
 *
 * 算式：`backdate + Σ_{j=i}^{stage-1} interval(j)`——最后一次落在 `backdate` 天前（`backdate`
 * 由 `demoSeedBackdateDays` 决定，到期那条恰等于本阶段间隔），往前每一次再加一个「本阶段要等多久」。
 * 于是流水之间的间距就是这套曲线自己规定的间距，而不是「随便编个等差数列」。
 */
function seedReviewDaysAgo(item: DemoSeedTerm, i: number): number {
  let days = demoSeedBackdateDays(item);
  for (let j = i; j < item.stage; j += 1) days += reviewIntervalDays(j);
  return days;
}

/** 推进到 `item.stage`，并把每次复习与末次间隔摆到该在的那天。 */
function scheduleSeedReview(termId: string, item: DemoSeedTerm): void {
  for (let i = 1; i <= item.stage; i += 1) {
    // ★ `silent`＝不发 `review_completed` 事件（契约 `GAMIFIED-AGENT-SPEC` §8.1 的学习日由真用户动作算）：
    //   种子是「让时间过去」的等价物，不是「有人今天复习了」，否则体验号一进来就自带连签与 XP。
    markReviewed(termId, true, DEMO_USER_ID, { silent: true });
    backdateLastReview(termId, seedReviewDaysAgo(item, i));
  }
}

/**
 * 把种子里用到的领域**纳入复习范围**。
 *
 * ★★ 这一步不能省，而省掉的失败是**静默**的：`term_domain.review_enabled` 是
 *   `NOT NULL DEFAULT 0`（老板 2026-09-18 拍板「默认全不选」，见 `migrations-list-v22.ts` 注释），
 *   而队列/概览读的是 `COALESCE(t.review_enabled, d.review_enabled, 0) = 1` ⇒ 新建领域下的词条
 *   **天然不在复习池**。实测过一次：八条种子全在库里、状态全算对，`listDueQueue` 仍返回 `[]`。
 *   ⇒ 不打开开关，「首屏有今天要背的东西」这句承诺就是假的。
 * ⚠️ 顺序：必须在 `scheduleSeedReview` **之前**——`setDomainReviewScope` 对「由关变开」会跑
 *   `resetProgress`（清零 `review_stage` 与 `last_reviewed_at`），放在后面会把刚排好的进度抹平。
 * ★ 这是对体验号**这一个账号**打开，不改任何默认值、也不改别人账号上的领域开关
 *   （owner 条件在 `setDomainReviewScope` 里带着）。
 */
function enableSeedDomains(): void {
  for (const domain of new Set(DEMO_SEED_TERMS.map((t) => t.domain))) {
    setDomainReviewScope(domain, true, DEMO_USER_ID);
  }
}

/**
 * 灌种子：返回写入的词条数（0 = 已灌过或池内已有内容）。
 * ★ 走 `saveOneTerm` 意味着**不发任何事件**（对比 `saveTerms` 会 publish `term_added`）
 *   ⇒ 体验号的 XP／每日活动不会被这批内容点亮，诚实计数（C4）也因此结构上数不到它。
 */
export function ensureDemoSeed(): number {
  if (poolAlreadyFilled()) return 0;
  const created = DEMO_SEED_TERMS.map((item) => ({
    item,
    row: saveOneTerm(item.term, item.definition, item.domain, DEMO_USER_ID),
  }));
  enableSeedDomains();
  for (const { item, row } of created) scheduleSeedReview(row.id, item);
  return created.length;
}

/** 登录路径上的入口：失败只降级为「空库」，不让体验进不去。 */
export function tryEnsureDemoSeed(): void {
  try {
    const n = ensureDemoSeed();
    // eslint-disable-next-line no-console -- 一次性运维日志（只有真空池灌入时才响一声），与 index.ts 的启动日志同类
    if (n > 0) console.log(`[sb-demo] 体验号种子内容已灌入 ${n} 条词条`);
  } catch (e) {
    console.warn('[sb-demo] 种子内容灌入失败（不影响进入应用）:', e instanceof Error ? e.message : e);
  }
}
