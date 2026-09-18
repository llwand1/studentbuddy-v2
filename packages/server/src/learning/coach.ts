/**
 * learning/coach — 复习督促域（v25，契约 `docs/COACH-SPEC.md`，老板 2026-09-18 拍板 B+C+E）。
 *
 * 四件事：
 *  ① **快照**（`coachSnapshot`）—— 胶囊与抽屉共用的那份欠账账本，数字全部来自
 *     `learning/term-review.ts`（判定唯一实现在 `shared/ebbinghaus.ts`，本文件不重算天数）；
 *  ② **卡片流水**（`listCoachCards` / `appendCard`）—— AI 卡 / 我的卡 / 提醒卡 / 复习动作卡；
 *  ③ **该不该催**（`coachState` → `shouldNudge`）—— 判据是**欠账**不是时间，见 shared/coach.ts；
 *  ④ **生成回复**（`generateCoachReply`）—— 走 `llm/router` 的 `coach` 角色（未绑则回退讲解模型），
 *     上下文 = 人设 + 快照 + 近 N 条流水，**不落 chat 的 messages 表**（它是另一条链路）。
 *
 * ★ 为什么复习打卡也记进这里：小窗的价值一半在「AI 说了什么」，另一半在**「我今天到底做了多少」**。
 *   打卡流水进这张表，抽屉里才能把「AI 让我背的」和「我真的背了的」并排摆出来。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { routeRole } from '../llm/router.js';
import { reviewOverview, listReviewQueue, markReviewed, reviewStreak, termScope } from './term-review.js';
import { MENTION_WINDOW_DAYS } from './mention.js';
import { buildCoachSystemPrompt } from './coach-prompt.js';
import {
  COACH_HISTORY_TURNS,
  COACH_MAX_REPLY_CHARS,
  COACH_TOP_TERMS,
  localDayKey,
  parseCoachTime,
  shouldNudge,
  type CoachCard,
  type CoachNudge,
  type CoachSnapshot,
  type CoachTrendCard,
} from '@sb/shared';
import type { ChatMessage } from '../llm/types.js';

/** 督促回复上限（token）：中文约 1 字 1~2 token，留足余量又不至于让模型写长文 */
const COACH_MAX_TOKENS = 900;
/** 督促温度：比聊天略低——要的是"照着快照说人话"，不是创作 */
const COACH_TEMPERATURE = 0.6;

export interface CoachState {
  snapshot: CoachSnapshot;
  nudge: CoachNudge;
  /** 上次主动提醒时间（SQLite 文本；从未提醒过为 null） */
  lastNudgeAt: string | null;
}

/** 归属过滤（与 `auth/ownership.ts` 同语义：null＝未登录单人本地模式，不过滤） */
function ownerClause(ownerId: string | null, column = 'owner_id'): { sql: string; params: string[] } {
  return ownerId === null ? { sql: `${column} IS NULL`, params: [] } : { sql: `${column} = ?`, params: [ownerId] };
}

/**
 * 督促快照：欠账账本。
 * ★ 直接复用 `reviewOverview`（不自己扫表）：概览页与小窗必须是同一份数字，
 *   两处各扫一次表 = 迟早出现「概览说欠 12 条、胶囊说欠 9 条」。
 */
export function coachSnapshot(): CoachSnapshot {
  const o = reviewOverview();
  const top = listReviewQueue(COACH_TOP_TERMS).map((t) => ({
    id: t.id,
    term: t.term,
    domain: t.domain,
    daysSince: t.review.daysSince,
    overdueDays: t.review.overdueDays,
    retention: t.review.retention,
  }));
  return {
    total: o.total,
    due: o.due,
    overdue: o.overdue,
    fresh: o.fresh,
    todayDone: o.todayDone,
    mastered: o.mastered,
    maxOverdueDays: o.maxOverdueDays,
    streak: reviewStreak(),
    top,
  };
}

/** 上次主动提醒时间（冷却判定的输入） */
export function lastNudgeAt(ownerId: string | null): string | null {
  const f = ownerClause(ownerId);
  const row = getDb()
    .prepare(
      `SELECT created_at FROM coach_messages WHERE ${f.sql} AND kind = 'nudge' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...f.params) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/**
 * 最近一张趋势卡落在**哪个本地日历日**（没出过返回 null）。这是「每天最多一张」的幂等闸门
 * （契约 `MEMORY-TREND-SPEC` §4.2：重启、多跑一次 tick 都不该多出一张图）。
 *
 * ★ 为什么返回「日键」而不是布尔：调用方拿它跟 `localDayKey(now)` 比，跨天判定就只剩一次比较，
 *   而且这个函数**不知道自己被问的是哪天**，将来要查历史（"上周出过几张"）也不用改签名。
 * ★ 为什么必须经 `parseCoachTime` 再取本地日：库里的 `created_at` 是 **UTC 文本**
 *   （`datetime('now')`），直接在 SQL 里 `date(created_at)` 会在 +8 区晚上错一天
 *   ——本仓已在日期段批吃过一次这个亏，故这里不做"更省事"的 SQL 日比较。
 */
export function lastTrendDayKey(ownerId: string | null): string | null {
  const f = ownerClause(ownerId);
  const row = getDb()
    .prepare(
      `SELECT created_at FROM coach_messages WHERE ${f.sql} AND kind = 'trend' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...f.params) as { created_at: string } | undefined;
  if (!row) return null;
  const t = parseCoachTime(row.created_at);
  return t ? localDayKey(t) : null;
}

/** 快照 + 提醒判定（服务端唯一出口：前端只渲染，不自己判该不该催） */
export function coachState(ownerId: string | null, now: Date = new Date()): CoachState {
  const snapshot = coachSnapshot();
  const last = lastNudgeAt(ownerId);
  const nudge = shouldNudge({
    due: snapshot.due,
    overdue: snapshot.overdue,
    maxOverdueDays: snapshot.maxOverdueDays,
    lastNudgeAt: last,
    now,
  });
  return { snapshot, nudge, lastNudgeAt: last };
}

/** 库里的一行流水 */
interface CoachRow {
  id: string;
  kind: string;
  content: string;
  meta: string | null;
  created_at: string;
}

/** 脏 kind 归一：库里可能存着旧版本/手改的值，统一落到 'ai'（宁可显示成 AI 卡也不让前端崩） */
function parseKind(raw: string): CoachCard['kind'] {
  return raw === 'me' || raw === 'nudge' || raw === 'review' || raw === 'trend' ? raw : 'ai';
}

/**
 * meta 里的榜单归一：**只信形状对的行**，坏值一律丢弃。
 * ★ 与 review 卡的取舍同源——meta 是 JSON 文本列，手改库/版本错位都可能让它坏掉，
 *   而**一条坏 meta 不该毁掉整张卡**（用户看到的是"趋势图没了"，而不是"某一行坏了"）。
 */
function pickRank(raw: unknown, key: 'domain' | 'term'): Array<{ key: string; count: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ key: string; count: number }> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const k = rec[key];
    if (typeof k === 'string' && typeof rec.count === 'number') out.push({ key: k, count: rec.count });
  }
  return out;
}

/**
 * 行 → 卡片（**唯一**的库行解释点；路由与生成都经它，保证形状一致）。
 *
 * ★ 两种结构化卡共用「正文进 `content`、图表数据进 `meta`」的落法：
 *   `content` 是**这张卡说给用户的那句话**（与 AI 卡/提醒卡的 `text` 同语义，将来要检索/列表也读得到），
 *   `meta` 是**只给前端渲染的机器字段**。故趋势卡的 `summary` 取自 `content`，不重复存一份。
 */
function toCard(row: CoachRow): CoachCard {
  const kind = parseKind(row.kind);
  const at = row.created_at;
  if (kind === 'review') {
    // meta 坏值不能毁掉整条流：解析失败就退回一张只带词的卡
    let meta: { termId?: string; term?: string; remembered?: boolean; stage?: number; intervalDays?: number } = {};
    try {
      meta = row.meta ? (JSON.parse(row.meta) as typeof meta) : {};
    } catch {
      meta = {};
    }
    return {
      id: row.id,
      kind: 'review',
      at,
      termId: meta.termId ?? '',
      term: meta.term ?? row.content,
      remembered: meta.remembered === true,
      stage: typeof meta.stage === 'number' ? meta.stage : 0,
      intervalDays: typeof meta.intervalDays === 'number' ? meta.intervalDays : 0,
    };
  }
  if (kind === 'trend') {
    let raw: Record<string, unknown> = {};
    try {
      raw = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    } catch {
      raw = {};
    }
    const trend: CoachTrendCard = {
      id: row.id,
      kind: 'trend',
      at,
      // 窗口天数缺省取 MENTION_WINDOW_DAYS（而不是 0）：0 天在 UI 上读作"没窗口"，比缺省更误导
      windowDays: typeof raw.windowDays === 'number' ? raw.windowDays : MENTION_WINDOW_DAYS,
      labels: Array.isArray(raw.labels) ? raw.labels.filter((x): x is string => typeof x === 'string') : [],
      values: Array.isArray(raw.values) ? raw.values.filter((x): x is number => typeof x === 'number') : [],
      topDomains: pickRank(raw.topDomains, 'domain').map((r) => ({ domain: r.key, count: r.count })),
      topTerms: pickRank(raw.topTerms, 'term').map((r) => ({ term: r.key, count: r.count })),
      summary: row.content,
      summarySource: raw.summarySource === 'ai' ? 'ai' : 'fallback',
    };
    return trend;
  }
  return { id: row.id, kind, text: row.content, at } as CoachCard;
}

/** 最近的流水（时间正序返回，前端直接渲染成流；默认取 60 条，够滚一屏） */
export function listCoachCards(ownerId: string | null, limit = 60): CoachCard[] {
  const f = ownerClause(ownerId);
  const n = Math.min(Math.max(Math.trunc(limit) || 60, 1), 300);
  const rows = getDb()
    .prepare(
      `SELECT id, kind, content, meta, created_at FROM coach_messages
        WHERE ${f.sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...f.params, n) as CoachRow[];
  return rows.reverse().map(toCard);
}

/** 写一条流水（唯一落点：所有卡都必须经此进库，卡片形状才不会有第二份实现） */
export function appendCard(
  ownerId: string | null,
  kind: CoachCard['kind'],
  content: string,
  meta?: Record<string, unknown>,
): CoachCard {
  const id = randomUUID();
  getDb()
    .prepare('INSERT INTO coach_messages (id, owner_id, kind, content, meta) VALUES (?, ?, ?, ?, ?)')
    .run(id, ownerId, kind, content, meta ? JSON.stringify(meta) : null);
  const row = getDb()
    .prepare('SELECT id, kind, content, meta, created_at FROM coach_messages WHERE id = ?')
    .get(id) as CoachRow;
  // ★ 回读库行再映射（不拿内存拼）：本仓在 auth 的 `createdAt` 上为「两个事实源」付过学费
  return toCard(row);
}

/**
 * 主动提醒：落一张提醒卡。**冷却在服务端把**（不靠前端自觉）。
 * 已冷却/无欠账时返回 `{ skipped: true }` 且**不落库**——否则每次开抽屉都多一条重复提醒。
 */
export function pushNudge(ownerId: string | null, now: Date = new Date()): { card: CoachCard | null; reason: string } {
  const state = coachState(ownerId, now);
  if (!state.nudge.should) return { card: null, reason: state.nudge.reason };
  const card = appendCard(ownerId, 'nudge', state.nudge.line);
  return { card, reason: state.nudge.reason };
}

/**
 * 复习打卡（小窗内的「记得 / 忘了」）：推进阶段 + 记一张动作卡。
 *
 * ★ v28 起与 `POST /api/terms/:id/review` **同一道范围闸门**：小窗队列里本来就只有范围内
 *   的词条（`listReviewQueue` 已过滤），但端点是公开的，不判范围的话会出现
 *   "库里记了一次复习、而词条页上它根本不显示"的静默错账。
 * ★ `status` 与 `error` 一起返回（不在这里落 HTTP）：域层给状态码、薄路由直通，
 *   是本仓既有手法（同 `routes/choice.ts` 的 `DomainError`）——404 与 409 对用户是
 *   两句不同的话（"词条没了" / "先把它纳入复习范围"），压成一个码前端就没法提示。
 */
export function coachMarkReviewed(
  ownerId: string | null,
  termId: string,
  remembered: boolean,
): { card: CoachCard } | { error: string; status: number } {
  const scope = termScope(termId);
  if (!scope) return { error: '词条不存在', status: 404 };
  if (!scope.inScope) return { error: '该词条未纳入复习范围，请先在复习范围里勾选它', status: 409 };
  const updated = markReviewed(termId, remembered);
  if (!updated) return { error: '词条不存在', status: 404 };
  const card = appendCard(ownerId, 'review', `${updated.term} · ${remembered ? '记得' : '忘了'}`, {
    termId: updated.id,
    term: updated.term,
    remembered,
    stage: updated.review.stage,
    intervalDays: updated.review.intervalDays,
  });
  return { card };
}

/**
 * 督促模型目标：`coach` 角色优先，**未绑定则回退讲解模型**。
 * ★ 为什么带回退：老库升级后 `role_bindings` 里没有 coach 这一行，若直接用 `routeRole('coach')`
 *   会得到空 model ⇒ 用户看到「该角色还没绑定模型」，而设置页里他什么都没改过。
 *   督促本质是日常对话，用讲解模型是合理默认；想换更便宜/更凶的模型再去设置页单独绑。
 */
export function resolveCoachTarget() {
  const own = routeRole('coach');
  if (own?.model) return own;
  return routeRole('explain') ?? own;
}

/** 流水 → 模型消息（只取 me/ai，且只取最近 N 条：督促是短对话，长历史既费钱又稀释上下文） */
function historyMessages(ownerId: string | null): ChatMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, content, meta, created_at FROM coach_messages
        WHERE ${ownerClause(ownerId).sql} AND kind IN ('me', 'ai')
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...ownerClause(ownerId).params, COACH_HISTORY_TURNS) as CoachRow[];
  return rows.reverse().map((r) => ({
    role: parseKind(r.kind) === 'me' ? ('user' as const) : ('assistant' as const),
    content: r.content,
  }));
}

export interface CoachReplyResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * 生成督促回复（流式：每个增量交给 `onToken`，路由负责 publish 到 SSE）。
 * 失败一律给**能照着改的**错误（ADR-5）：没配服务商 / 没绑模型 / 模型报错，三者说清是哪一种。
 */
export async function generateCoachReply(opts: {
  ownerId: string | null;
  text: string;
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<CoachReplyResult> {
  const target = resolveCoachTarget();
  if (!target) return { ok: false, text: '', error: '没有启用的服务商，请到设置里配一个模型服务商' };
  if (!target.model) return { ok: false, text: '', error: '督促模型还没绑定：请到设置 → 角色模型绑定里给「督促」选一个模型' };
  const snapshot = coachSnapshot();
  const messages: ChatMessage[] = [
    { role: 'system', content: buildCoachSystemPrompt(snapshot) },
    ...historyMessages(opts.ownerId),
    { role: 'user', content: opts.text },
  ];
  let acc = '';
  try {
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages,
      temperature: COACH_TEMPERATURE,
      maxTokens: COACH_MAX_TOKENS,
      streamMode: 'stream',
      signal: opts.signal,
    })) {
      if (chunk.content) {
        acc += chunk.content;
        opts.onToken(chunk.content);
      }
      if (chunk.done) break;
    }
  } catch (err) {
    // ★ 用户主动停止（点了停止按钮 / 直接发了下一轮打断了这一轮）：**不是错误**。
    //   已吐出的部分照常返回并落库（"说了一半的话"也是他说过的），空的部分什么都不落。
    //   若在这里报错，用户会看到自己点了停止却换来一张「没回上」的卡——那是工具在怪用户。
    if (opts.signal?.aborted) return { ok: true, text: acc.trim() };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, text: acc, error: `模型调用失败：${msg}` };
  }
  const text = acc.trim() || `（模型没有返回内容）`;
  return { ok: true, text: text.slice(0, COACH_MAX_REPLY_CHARS * 2) };
}
