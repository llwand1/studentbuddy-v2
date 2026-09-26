/**
 * shared/term-cards — 词条卡牌的星级曲线与稀有度契约（2026-09-25 新建，
 * 契约 `docs/TERM-CARDS-SPEC.md` §2）。
 *
 * ★ 为什么放 shared（与 `ebbinghaus.ts` 立项理由同一条）：**「这条词条现在几星」必须前后端
 *   同一个答案**。前端要在卡墙上画星位、服务端要排今天的宝箱候选和派单进度——两边各算一份
 *   就会出现「列表说 ★2、派单文案说还差 3 张（按 ★3 算的）」这种自打脸。
 *   本仓已在 `doc-rag.ts` 常量双写、`ebbinghaus.ts` 判定双写上各付过一次学费。
 *
 * ★ **只放纯函数、不碰 IO**（仓内既有约定：判定逻辑留在可单测的纯函数里，先例
 *   `chat/doc-name.ts`／`study-flow/flow-viewport.ts`）。卡数本身怎么来，见
 *   `packages/server/src/learning/term-cards.ts`——那里是唯一读两张流水的地方。
 *
 * 口径三条（改码前必读）：
 *  1. **指数曲线**：★n 需要累计 `2^n` 张卡（★1=2、★2=4、★3=8、★4=16…★8=256）。
 *     这是老板 2026-09-25 对第一版线性方案（2 卡=1 星）的**明确改判**：「升级不能这么简单，
 *     要每次都次方级，3 星就是要 8 次」。
 *  2. **稀有度按卡数分档，不按星级分档**。★ 这条不是口味，是让指数曲线活得下来的那一环：
 *     按星分档时 ★0 与 ★1 会挤在同一档，而真实语料下库里绝大多数词条恰好停在 ★0～★1
 *     （demo 实测：日均提及 1～3 次时全库 80% 是 ★0）。按卡分档让「攒到 2 张」就有 R 的观感。
 *  3. **封顶 ★8 = 256 张**，是长期天花板不是设计目标（老板明确保留）。
 *     ★ 封顶必须存在：`starOf` 不封顶会在高频用户身上算出 ★20+，而 UI 的星位是画死的。
 */

/** 星级上限（★8）。见头注口径 3 */
export const CARD_STAR_CAP = 8;

/**
 * ★n 所需的**累计**卡数 = 2^n（★1=2、★2=4、★3=8、★4=16…★8=256）。
 * ★★ 这个式子必须与 `starOf` 严格互逆（`starOf(cardsForStar(n)) === n`）。
 *   本文件初稿把它写成 `2^(n+1)`，于是 `cardsForStar(1)=4` 而 `starOf(2)=1` ——
 *   **同一个模块里两个函数对"★1 要几张"给出两个答案**，被自己的测试当场抓住。
 *   这正是头注口径 1 立这条曲线的初衷（"3 星就是要 8 次"），互逆性是它的承重墙。
 *   ⇒ 改任何一侧都必须过 `term-cards.test.ts` 里那条互逆断言。
 * ★ ★0 走同一条式子（2^0 = 1），不需要特判：库里任何词条至少有一张"建卡那张"，
 *   所以卡数恒 ≥1，★0 的门槛恰好就是 1。
 */
export function cardsForStar(star: number): number {
  const s = Math.min(Math.max(Math.trunc(star) || 0, 0), CARD_STAR_CAP);
  return Math.pow(2, s);
}

/**
 * 卡数 → 星级。
 * ★ `cards <= 0` 单独挡：`Math.log2(0)` 是 `-Infinity`，`Math.floor(-Infinity)` 仍是
 *   `-Infinity`，`Math.min(8, -Infinity)` 会把负无穷一路带到 UI 的数组下标上
 *   （`Array.from({length: -Infinity})` 抛 RangeError）。这条不是假想：卡数为 0 的词条
 *   在任何"先算星、后有卡"的路径上都会出现。
 */
export function starOf(cards: number): number {
  const c = Math.trunc(cards) || 0;
  if (c <= 0) return 0;
  return Math.min(CARD_STAR_CAP, Math.floor(Math.log2(c)));
}

/** 距下一星还差几张；已在封顶时 `needed` 为 null（UI 据此显示"已满星"而不是"还差 0 张"） */
export function nextStarProgress(cards: number): {
  star: number;
  nextStar: number | null;
  needed: number | null;
  /** 当前星 → 下一星这一段已完成的比例（0～1）。封顶时恒为 1 */
  pct: number;
} {
  const star = starOf(cards);
  const c = Math.trunc(cards) || 0;
  if (star >= CARD_STAR_CAP) return { star, nextStar: null, needed: null, pct: 1 };
  // ★ `floorCards` 是**当前星**的门槛、`target` 是**下一星**的门槛 ⇒ 刚升星那一刻 `pct` 恰好归 0。
  //   （初稿这里取的是"上一星"的门槛，于是"刚升到 ★1"显示成"已走完 ★1→★2 的全程"。）
  const floorCards = cardsForStar(star);
  const target = cardsForStar(star + 1);
  const span = Math.max(target - floorCards, 1);
  const done = Math.min(Math.max(c - floorCards, 0), span);
  return { star, nextStar: star + 1, needed: Math.max(target - c, 0), pct: done / span };
}

/** 稀有度档（N 普通 / R 稀有 / SR 极稀 / SSR 传说）。ASCII 键：存库与 `data-*` 属性都用它 */
export type CardRarity = 'N' | 'R' | 'SR' | 'SSR';

/**
 * 督促频道键的**同族**：卡牌频道键。四向隔离（聊天 `sessionId`／PK `pk:`／督促 `coach:`／卡牌 `cards:`）。
 * ★ 不能复用 `coach:` —— 一旦混用，两侧的 `seq` 就不可比（每条频道各自从 1 起算），
 *   客户端的 `acceptSeq(since, seq)` 会把另一条频道的帧大面积误丢（bug-ledger B-007 那条路）。
 */
export function cardsChannel(ownerId: string | null | undefined): string {
  return `cards:${ownerId ?? 'local'}`;
}

/**
 * 各档的**入档卡数下限**（见头注口径 2：按卡数、不按星级）。
 * ⇒ 1 张 N、2～3 张 R、4～7 张 SR、8 张及以上 SSR。
 */
export const RARITY_MIN_CARDS: Readonly<Record<CardRarity, number>> = {
  N: 0,
  R: 2,
  SR: 4,
  SSR: 8,
};

/** 卡数 → 稀有度（★ 与星级无关，见口径 2） */
export function rarityOf(cards: number): CardRarity {
  const c = Math.trunc(cards) || 0;
  if (c >= RARITY_MIN_CARDS.SSR) return 'SSR';
  if (c >= RARITY_MIN_CARDS.SR) return 'SR';
  if (c >= RARITY_MIN_CARDS.R) return 'R';
  return 'N';
}

// ── 宝箱钥匙（契约 §3）─────────────────────────────────────────────────────────

/** 每日无条件可开的次数 */
export const FREE_OPENS_PER_DAY = 3;

/**
 * 每日开盒**硬上限**。
 * ★ 没有这条，玩家攒 20 把钥匙一天开完会同时破掉两件事：T3 动效的稀缺性
 *   （「每日宝箱」不再是每日的事），和抽卡去重——一天把词池抽穿，之后每天开盒都是空池。
 */
export const DAILY_OPEN_CAP = 8;

/** 赚来的钥匙跨日**不清零**（囤积是玩家自由），但受 `DAILY_OPEN_CAP` 限当日节奏 */
export interface ChestKeyState {
  free_used: number;
  earned_keys: number;
  /** 今天已经开过几次（含免费与赚来的） */
  opened_today: number;
}

/**
 * 今天还能开几次 = min(剩余钥匙, 当日上限余量)。
 * ★ 返回 0 的两种情况**必须让 UI 能区分**（`exhausted`／`capped`），
 *   因为对用户的说法完全不同：「钥匙用完了，完成一单再加一次」
 *   vs 「今天已经开满 8 次了，明天请早」。
 */
export function opensLeft(state: ChestKeyState): { left: number; reason: 'ok' | 'exhausted' | 'capped' } {
  const keys = FREE_OPENS_PER_DAY - state.free_used + state.earned_keys;
  const room = DAILY_OPEN_CAP - state.opened_today;
  if (keys <= 0) return { left: 0, reason: 'exhausted' };
  if (room <= 0) return { left: 0, reason: 'capped' };
  return { left: Math.min(keys, room), reason: 'ok' };
}

// ── 派单意图（契约 §5，`dedupe_key` 的**唯一**拼装处）───────────────────────────

/**
 * ★★ 键里**不得含会变的数字**（进度百分比、剩余张数都不行）——教训直接抄自
 *   `chat/memory-digest.ts`：`user_memory` 的 UNIQUE 是 `(user_id, kind, content)`，
 *   把会变的数写进 content ⇒ 数每变一次新增一行、旧行永不消失、两条记录互相打脸。
 *   ⇒ 键只表达**意图**（推进到哪一星），进度数字进 `why` 文案、不进键。
 *
 * @param targetStar 目标星级——它随词条推进而变，但**变了就该派一张新单**，
 *   所以它是意图的一部分而不是"会变的数"。区别在此：`pct` 每刷一次都不同（那是同一个意图
 *   的不同完成度），`targetStar` 不同则是**另一件事**（从 ★2 推到 ★3 ≠ 从 ★3 推到 ★4）。
 */
export function advanceDedupeKey(termId: string, targetStar: number): string {
  return `advance:${termId}:${Math.min(Math.max(Math.trunc(targetStar) || 0, 1), CARD_STAR_CAP)}`;
}

/** 破停滞：卡数停在 `4～7` 这种"摸到 SSR 却没够着"的区间 */
export function unstallDedupeKey(termId: string): string {
  return `unstall:${termId}`;
}

/**
 * 补池：派"审一条候选词"。★ 键的形状与 `term_pool_candidate` 的 `UNIQUE(owner_id, term, domain)`
 *   **故意同构**——一条候选最多派一单，重复生成/重复 tick 都撞键跳过。
 */
export function poolDedupeKey(term: string, domain: string): string {
  return `pool:${domain}:${term}`;
}
