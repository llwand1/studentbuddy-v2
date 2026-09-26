/**
 * learning/chest.ts — 每日宝箱：钥匙账、抽新词、收下入库（契约 `docs/TERM-CARDS-SPEC.md` §3／§6）。
 *
 * ★ 三件容易写错的事，本文件把它们钉在注释里：
 *  1. **免费次数按本地日历日归零**，不用 SQL `date('now')`（那是 UTC 日，+8 区晚上会提前一天）。
 *     ⇒ `free_day` 存 `localDayKey(now)`，判"新的一天"在读侧做，**不需要任何夜间任务**。
 *     ★ 归零是**虚拟**的：`readKeys` 读到 `free_day` 不是今天就当计数为 0 返回，
 *     只在**真开一次盒**时才把归零后的值写回（`ensureToday`）。读一次写一行会让"打开面板"
 *     变成写操作，而面板是每次进首页都要拉的。
 *  2. **earned 跨日不清零**（囤钥匙是玩家自由），但当日开盒总数受 `DAILY_OPEN_CAP` 拦。
 *     ⇒ 所以 `free_used` 与 `opened_today` 是两列（v45 那段 ★★ 注释是这条的唯一解释处）。
 *  3. **抽中 ≠ 收下 ≠ 纳入复习**，三态分别在 `accepted` / `in_scope` 上表达。
 *     ★ 未收下的那次开盒**照样烧掉一把钥匙**、**照样进"已抽过"去重集**——这是刻意的：
 *     不烧则"不满意就重抽"可以白刷到满意为止（抽卡的稀缺感当场归零），
 *     不进去重集则同一条词明天还会再来一次。
 */
import { randomUUID } from 'node:crypto';
import {
  CHEST_POOL_SEED,
  FREE_OPENS_PER_DAY,
  localDayKey,
  opensLeft,
  type ChestPoolEntry,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { announceCards } from './card-announce.js';
import { saveOneTerm } from './terms.js';
import { termCards, type TermCards } from './term-cards.js';

/** 池子来源两值，落 `chest_open.source_kind`（ASCII 词，同 `study_task.kind` 的判据） */
export type PoolSource = 'seed' | 'candidate';

/** 一次开盒的结果 */
export interface ChestDraw {
  openId: string;
  term: string;
  domain: string;
  definition: string;
  source: PoolSource;
  /** 这次花掉的是免费次数还是赚来的钥匙（UI 的"−1"提示要说清是哪本账）。
   *  ★ 回读待处理那张时是 `null`：库里**没存**本次花的是哪本账（`chest_keys` 只有汇总数，
   *    流水行里没有 cost 列）——与其编一个，不如让前端不显示那一格。 */
  cost: 'free' | 'earned' | null;
}

/** `GET /state` 的响应体（前端面板一次拿全，避免开盒前先发三个请求） */
export interface ChestState {
  day: string;
  freeUsed: number;
  freeLeft: number;
  earnedKeys: number;
  openedToday: number;
  /** 今天还能开几次；`reason` 让面板能区分「没钥匙」与「开满了」两种不同的话 */
  left: ReturnType<typeof opensLeft>;
  /** 池子里还有多少条"我没见过"的词。0 = 只能等候选通过或明天，面板必须说实话 */
  poolLeft: number;
  /** 上一次抽了还没收下的那张（刷新后仍在——开盒是**已经发生**的事件，不能因为换页面就消失） */
  pending: ChestDraw | null;
}

interface KeysRow {
  free_used: number;
  earned_keys: number;
  opened_today: number;
  free_day: string;
  /** 最近一次「宝箱可开」提醒落在哪个本地日历日（★ 不参与跨日归零，它就是归零判据本身） */
  ready_day: string;
}

const EMPTY_KEYS: KeysRow = { free_used: 0, earned_keys: 0, opened_today: 0, free_day: '', ready_day: '' };

function readKeys(ownerId: string | null): KeysRow {
  const row = getDb()
    .prepare(
      `SELECT free_used, earned_keys, opened_today, free_day, ready_day FROM chest_keys WHERE owner_id = ?`,
    )
    .get(ownerForWrite(ownerId)) as KeysRow | undefined;
  return row ?? EMPTY_KEYS;
}

/**
 * 生效中的钥匙账：跨日时把两个"今日"计数当 0 返回（见文件头 1.）。
 * ★ 返回的是**读数**，库里那一行可能还停在昨天的计数上——这是有意的（文件头解释过）。
 */
function effectiveKeys(ownerId: string | null, now: Date): KeysRow {
  const stored = readKeys(ownerId);
  const day = localDayKey(now);
  if (stored.free_day === day) return stored;
  return { ...stored, free_used: 0, opened_today: 0, free_day: day };
}

/** 把（可能已归零的）计数写回。★ 只在开盒/发钥匙/发提醒这三条**真写路径**上调用 */
function writeKeys(ownerId: string | null, k: KeysRow): void {
  getDb()
    .prepare(
      `INSERT INTO chest_keys (owner_id, free_used, earned_keys, opened_today, free_day, ready_day, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(owner_id) DO UPDATE SET
         free_used = excluded.free_used, earned_keys = excluded.earned_keys,
         opened_today = excluded.opened_today, free_day = excluded.free_day,
         ready_day = excluded.ready_day, updated_at = excluded.updated_at`,
    )
    .run(ownerForWrite(ownerId), k.free_used, k.earned_keys, k.opened_today, k.free_day, k.ready_day);
}

/** 归一名：去空白 + 小写。★ 别名与正名进同一个集合，这是 §3 去重② 能成立的前提 */
function normName(s: string): string {
  return s.trim().toLowerCase();
}

/** 池子里一条目的稳定标识：底座按词条名、候选按行 id（两者都**不随释义改写而变**） */
function poolSlug(source: PoolSource, key: string): string {
  return `${source === 'seed' ? 'seed' : 'cand'}:${key}`;
}

interface OpenRow {
  id: string;
  source_kind: string;
  pool_slug: string | null;
  pool_term: string;
  pool_domain: string;
  pool_definition: string;
  term_id: string | null;
  accepted: number;
}

function toDraw(r: OpenRow, cost: ChestDraw['cost']): ChestDraw {
  return {
    openId: r.id,
    term: r.pool_term,
    domain: r.pool_domain,
    definition: r.pool_definition,
    source: r.source_kind === 'candidate' ? 'candidate' : 'seed',
    cost,
  };
}

/**
 * 当前可抽的条目（契约 §3 三段去重全在这里）。
 *
 * ★ 为什么把"用户库里的名字"整份拉进内存而不是写进 SQL 的 `NOT IN`：
 *   别名在库里是**一列 JSON 文本**（`term_library.aliases`），SQL 表达式判不了
 *   「本条目的名字出现在那串 JSON 的任何一项里」——`LIKE '%"主动回忆"%'` 那种写法
 *   会把「不主动回忆」也算进去。≤500 行的集合，解析在 JS 侧做才是对的工具。
 *   （`parseAliases` 的容错口径一并复用：脏 JSON 当作没别名，不因一行坏数据丢掉整池。）
 * ⚠️ **候选表的名字不进 `owned`**——`owned` 的语义是"用户库里已有"，把候选塞进去等于
 *   让 approved 的候选把自己过滤掉（本批第一版就是这么红的：`approved 才进池` 那条用例当场抓住）。
 *   候选侧的重复由下面的 `taken` 按名收敛（同名时底座优先，slug 稳定不漂移）。
 */
/** 池子里的一条可抽项：条目本体 + 它的去重键 + 来源（★ 三者一起返回，见 `openChest` 的注释） */
interface PoolItem {
  entry: ChestPoolEntry;
  slug: string;
  source: PoolSource;
}

export function drawablePool(ownerId: string | null): PoolItem[] {
  const owner = ownerForWrite(ownerId);
  const db = getDb();

  const owned = new Set<string>();
  for (const t of db.prepare('SELECT term, aliases FROM term_library WHERE owner_id = ?').all(owner) as Array<{
    term: string;
    aliases: string | null;
  }>) {
    owned.add(normName(t.term));
    for (const a of parseAliasList(t.aliases)) owned.add(normName(a));
  }

  const drawn = new Set<string>(
    (
      db.prepare(`SELECT pool_slug FROM chest_open WHERE owner_id = ? AND pool_slug IS NOT NULL`).all(owner) as Array<{
        pool_slug: string;
      }>
    ).map((r) => r.pool_slug),
  );

  const items: PoolItem[] = [
    ...CHEST_POOL_SEED.map((e) => ({ entry: e, slug: poolSlug('seed', e.term), source: 'seed' as PoolSource })),
    ...(
      db
        .prepare(
          `SELECT id, term, domain, definition, aliases FROM term_pool_candidate
            WHERE owner_id = ? AND status = 'approved'`,
        )
        .all(owner) as Array<{ id: string; term: string; domain: string; definition: string; aliases: string }>
    ).map((c) => ({
      entry: { term: c.term, definition: c.definition, domain: c.domain, aliases: parseAliasList(c.aliases) },
      slug: poolSlug('candidate', c.id),
      source: 'candidate' as PoolSource,
    })),
  ];

  const out: PoolItem[] = [];
  const taken = new Set<string>(); // 池内正名去重：底座与人工通过的候选可能撞同一个词
  for (const it of items) {
    const { entry, slug } = it;
    if (drawn.has(slug)) continue; // ③ 本人已抽过
    if (owned.has(normName(entry.term))) continue; // ① 库里同名
    // ② 撞别名：正名撞别人的别名、别名撞别人的正名，两个方向都要判
    if (entry.aliases.some((a) => owned.has(normName(a)))) continue;
    if (taken.has(normName(entry.term))) continue;
    taken.add(normName(entry.term));
    out.push(it);
  }
  return out;
}

/** 别名 JSON → string[]（与 `terms.ts` 的 `parseAliases` 同口径；那边没导出可复用的形状，抄四行不换依赖） */
function parseAliasList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function chestState(ownerId: string | null, now = new Date()): ChestState {
  const k = effectiveKeys(ownerId, now);
  const pending = pendingDraw(ownerId);
  return {
    day: k.free_day,
    freeUsed: k.free_used,
    freeLeft: Math.max(0, FREE_OPENS_PER_DAY - k.free_used),
    earnedKeys: k.earned_keys,
    openedToday: k.opened_today,
    left: opensLeft(k),
    poolLeft: drawablePool(ownerId).length,
    pending: pending ? toDraw(pending, null) : null,
  };
}

/**
 * 最近一次「抽了还没收下」的开盒。
 * ⚠️ 只回最新一张：连着开三次都不收，前两张就当"抽到就走"。这是**有意的降级**——
 *   面板上摆三张待处理的卡会把一个仪式动作变成待办清单，而这三行的账仍在 `chest_open` 里，
 *   想查多少人抽完就走随时数得出来（这正是 §3 留 `accepted` 这一列的理由）。
 */
function pendingDraw(ownerId: string | null): OpenRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, source_kind, pool_slug, pool_term, pool_domain, pool_definition, term_id, accepted
         FROM chest_open WHERE owner_id = ? AND accepted = 0
        ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
    )
    .get(ownerForWrite(ownerId)) as OpenRow | undefined;
  return row ?? null;
}

export type OpenResult =
  | { ok: true; draw: ChestDraw; state: ChestState }
  | { ok: false; reason: 'exhausted' | 'capped' | 'empty' };

/**
 * 开一次盒：扣一把钥匙 → 随机抽一条可抽词 → **当场落流水**（`accepted = 0`）。
 *
 * ★ 抽卡与写流水在同一个事务里：否则"扣了钥匙没抽到"或"抽到了没记账"都会留下
 *   用户看得见、库里查不到的差额（这把尺一旦不准，后面所有统计都白算）。
 * ★ 成本判据只算一次：先 `effectiveKeys` 定出本次花哪本账，再照它写回。
 *   开盒是**同步**函数、Express 每请求一 tick，所以读写之间不会插进别的写者；
 *   若哪天改成异步，这里必须换成条件 UPDATE（`WHERE opened_today = ?`），不能靠这个假设。
 * ⚠️ 随机源用 `Math.random` 不作弊：本功能**没有付费**，保底/伪随机那套是为付费抽卡设计的，
 *   套在每天 3 次的免费宝箱上只会拖长获取周期，不换任何收益。
 */
export function openChest(ownerId: string | null, now = new Date()): OpenResult {
  const k = effectiveKeys(ownerId, now);
  const gate = opensLeft(k);
  if (gate.left <= 0) return { ok: false, reason: gate.reason === 'capped' ? 'capped' : 'exhausted' };

  const pool = drawablePool(ownerId);
  if (pool.length === 0) return { ok: false, reason: 'empty' };

  const pick = pool[Math.floor(Math.random() * pool.length)] as PoolItem;
  const id = randomUUID();
  const db = getDb();
  const cost: 'free' | 'earned' = k.free_used < FREE_OPENS_PER_DAY ? 'free' : 'earned';
  const day = localDayKey(now);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO chest_open (id, owner_id, opened_day, source_kind, pool_slug, pool_term, pool_domain, pool_definition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ownerForWrite(ownerId), day, pick.source, pick.slug, pick.entry.term, pick.entry.domain, pick.entry.definition);
    writeKeys(ownerId, {
      ...k,
      free_used: cost === 'free' ? k.free_used + 1 : k.free_used,
      earned_keys: cost === 'earned' ? k.earned_keys - 1 : k.earned_keys,
      opened_today: k.opened_today + 1,
      free_day: day,
    });
  })();

  const draw: ChestDraw = {
    openId: id,
    term: pick.entry.term,
    domain: pick.entry.domain,
    definition: pick.entry.definition,
    source: pick.source,
    cost,
  };
  return { ok: true, draw, state: chestState(ownerId, now) };
}

export type AcceptResult =
  | { ok: true; termId: string; cards: TermCards | null; inScope: boolean }
  | { ok: false; error: string; status: number };

/**
 * 收下这张卡：写进用户自己的词条库，`accepted = 1`，可选同时纳入复习范围。
 *
 * ★ 走 `saveOneTerm` 而不是自己 INSERT：领域登记（v19 不变式：词条域 ⊆ 领域登记册）、
 *   同名词条的 upsert、索引重建全在那条路上。绕过它写一份 = 宝箱来的词条是"二等公民"。
 * ★ `review` 为真才置 `review_enabled = 1`：v28 起新词条**默认不在复习范围**，
 *   而 `TermsPage.tsx` 那条注释说得很直白——不在池子里却显示"催你复习"是假的。
 *   ⇒ 所以面板必须给两枚钮（收下 / 收下并纳入复习），而不是替用户默认勾选。
 */
export function acceptDraw(ownerId: string | null, openId: string, review: boolean): AcceptResult {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const row = db
    .prepare(
      `SELECT id, source_kind, pool_slug, pool_term, pool_domain, pool_definition, term_id, accepted
         FROM chest_open WHERE id = ? AND owner_id = ?`,
    )
    .get(openId, owner) as OpenRow | undefined;
  if (!row) return { ok: false, error: '这张卡不存在', status: 404 };
  if (row.accepted === 1) return { ok: false, error: '这张卡已经收过了', status: 409 };

  const saved = saveOneTerm(row.pool_term, row.pool_definition, row.pool_domain, ownerId);
  const termId = saved.id;
  if (!termId) return { ok: false, error: '词条没落库，请刷新重试', status: 500 };

  db.transaction(() => {
    db.prepare(`UPDATE chest_open SET accepted = 1, term_id = ?, in_scope = ? WHERE id = ?`).run(
      termId,
      review ? 1 : 0,
      openId,
    );
    if (review) {
      // ★ 逐条开关：只动这一条，不碰领域的默认值（那会影响他还没收下的其它词条）
      db.prepare(`UPDATE term_library SET review_enabled = 1 WHERE id = ? AND owner_id = ?`).run(termId, owner);
    }
  })();

  const cards = termCards(termId, ownerId);
  // ★ 响应体里已经带 `cards` 了，这里再推一帧不是冗余：卡墙可能是**另一个还开着的视图**，
  //   而推的是绝对值（同 `card-announce.ts` 文件头那条判据）。
  announceCards(ownerId, [termId]);
  return { ok: true, termId, cards, inScope: review };
}

/**
 * 完成一单任务 → 发一把钥匙。★ 由 `learning/tasks.ts` 在状态**从 open 翻到 done** 的那一次调用，
 * 所以它自己不需要防重复：重复调用意味着调用方漏了那翻转判据（宁可多测一次也不要在这里加计数器）。
 */
export function grantEarnedKey(ownerId: string | null, now = new Date()): void {
  const k = effectiveKeys(ownerId, now);
  writeKeys(ownerId, { ...k, earned_keys: k.earned_keys + 1 });
}

/**
 * 领一次「宝箱可以开了」的**日级提醒配额**（契约 §7.2 的 `chest_ready` 的闸门）。
 *
 * ★ 本函数**只判、只记账，不发 SSE**：把"今天该不该提醒"（要落库、可单测）与
 *   "提醒怎么发"（一条 `publish`，在 `learning/game-tick.ts`）分开。
 * ★ 为什么值得每天推一次：本功能的立项理由是产品**没有主动性**（契约 §0），而开箱是其中
 *   唯一每天必然发生的事。一天推两条是噪音 ⇒ 日级闸门必须有，且只能落在库里
 *   （`ready_day` 那一列的 v45 ★★★ 注释记了为什么不能放内存）。
 * ⚠️ 三个条件缺一不推：还能开（`left > 0`）、今天没推过、**池子里有词可抽**。
 *   最后一条不是保守——提醒一个人去开一个抽不出东西的箱子，等于把"这功能坏了"送到他眼前。
 * ⚠️ 顺带把跨日归零后的计数写回了（`writeKeys` 收的是 `effectiveKeys` 的结果）。这与文件头
 *   第 1 条「读时不写」不冲突：本函数只在 6 小时 tick 上调用，**面板读口 `chestState` 依旧零写**。
 */
export function claimChestReady(
  ownerId: string | null,
  now = new Date(),
): { openedDay: string; left: number } | null {
  const k = effectiveKeys(ownerId, now);
  const gate = opensLeft(k);
  if (gate.left <= 0) return null;
  if (k.ready_day === k.free_day) return null;
  if (drawablePool(ownerId).length === 0) return null;
  writeKeys(ownerId, { ...k, ready_day: k.free_day });
  return { openedDay: k.free_day, left: gate.left };
}
