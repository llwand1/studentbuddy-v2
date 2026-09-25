/**
 * pk/invite — 「AI 主动发起对战」的邀请域层（契约 docs/PK-SPEC.md §16，2026-09-24 老板点单）。
 *
 * 职责边界：入参归一 + 频率闸门 + 落库 + SSE 下发 + 接受时建房开局。
 * 不碰 LLM（工具面在 `chat/tools/offer-pk-battle.ts`）、不碰渲染（薄路由只做状态码映射）。
 *
 * ★ 为什么这张表落库、而房间仍刻意留在内存（§4 的划界不改）：邀请要活过三件内存态挡不住的事——
 *   ① 刷新/重连要把未答复的卡捞回来（SSE 缓冲 60s 无订阅即回收，`ask_choices` 正是为此才有
 *      `listPendingChoices`）；② 闸门要数「跨进程重启的量」，本仓部署频繁，放进程内 Map
 *      一重启就归零＝把闸门设在会被冲掉的地点上；③ 双点裁决要有唯一权威（见 `markAccepted`）。
 *
 * ★ 与 `chat/choice.ts` 的关键差异：**不挂起**。那边的 `askChoice` 返回 Promise 等用户点选，
 *   因为工具拿不到答复就没法继续讲；这边的语义是「邀请已发出，他还没决定」——本轮正常结束。
 *   拿 `ask_choice` 那条路走会把会话钉在 busy 上（用户走开＝整轮卡住），而「可以拒绝」就成了假承诺。
 *   所以本文件没有 resolver Map、没有 await，只有一次 `publish`。
 *
 * 过期不做成状态：读侧按 `created_at` 判旧（§16.4）。加一个终态就多一条写路径与一条并发裁决，
 * 而「旧邀请不再骚扰」这件事纯读就能做到。
 */
import { randomUUID } from 'node:crypto';
import {
  normalizePkInviteInput,
  PK_INVITE_OWNER_DAILY_MAX,
  PK_INVITE_SESSION_COOLDOWN_MS,
  PK_ROOM_TTL_MS,
  type PkIdentity,
  type PkInviteError,
  type PkInviteRecord,
  type PkInviteStatus,
  type PkRoomState,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { canAccessSession } from '../auth/ownership.js';
import { publish } from '../chat/sse-bus.js';
import { acceptInviteRoom, getRoomState } from './room.js';

// ── 存储层（`pk_invites` 表读写，全部 SQL 集中在此，别处不再写一份）──

interface InviteRow {
  id: string;
  session_id: string;
  owner_id: string | null;
  topic: string;
  reason: string;
  status: string;
  room_id: string | null;
  created_at: string;
}

/** SQLite `datetime('now')`（UTC 文本）→ epoch ms；解析失败回落 0。与 `chat/choice.ts` 同形（两行换算，不值当抽公用模块） */
const utcMs = (s: string): number => Date.parse(`${s.replace(' ', 'T')}Z`) || 0;

/**
 * 状态归一：`status` 列**刻意没有 CHECK 约束**（沿用 v25 `coach_messages.kind` 的取向：
 * 状态集还会长，每加一值配一次迁移不值当）。⇒ 脏值不能当 `pending` 用（那会让一张谁都不该
 * 再点的卡继续可点），一律按终态处理。
 */
const toStatus = (raw: string): PkInviteStatus =>
  raw === 'pending' || raw === 'accepted' || raw === 'rejected' ? raw : 'rejected';

function toRecord(r: InviteRow): PkInviteRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    ownerId: r.owner_id,
    topic: r.topic,
    reason: r.reason,
    status: toStatus(r.status),
    roomId: r.room_id,
    createdAt: utcMs(r.created_at),
  };
}

/** ms → SQLite 修饰串（`-300 seconds`）。★ 用**秒**不用分：常量改成 90s 时这条仍然精确，不会因为单位而悄悄错档 */
const sqliteAgo = (ms: number): string => `-${Math.round(ms / 1000)} seconds`;

const selectById = (id: string): InviteRow | undefined =>
  getDb().prepare('SELECT * FROM pk_invites WHERE id = ?').get(id) as InviteRow | undefined;

function insertInvite(rec: PkInviteRecord): void {
  getDb()
    .prepare(
      `INSERT INTO pk_invites (id, session_id, owner_id, topic, reason, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(rec.id, rec.sessionId, rec.ownerId, rec.topic, rec.reason);
}

/**
 * 条件更新为已接受。`WHERE status='pending'` 是双端并发点选的**唯一裁决**：
 * 第二只手 changes=0，调用方据此走「返回第一次那间房」的幂等分支，**不覆盖 `room_id`**
 * （覆盖＝两个用户各进一局，而卡片显示的是另一局）。与 `choice.ts:markAnswered` 同写法。
 */
function markAccepted(id: string, roomId: string): boolean {
  return getDb()
    .prepare(`UPDATE pk_invites SET status='accepted', room_id=? WHERE id=? AND status='pending'`)
    .run(roomId, id).changes === 1;
}

function markRejected(id: string): boolean {
  return getDb()
    .prepare(`UPDATE pk_invites SET status='rejected' WHERE id=? AND status='pending'`)
    .run(id).changes === 1;
}

// ── 频率闸门（§16.7：判据全部是 SQL，不是进程内 Map）─────────────

/** 命中哪条闸门就返回哪条的回灌文案（给模型看的话），全通过返回 null */
function gateBlock(sessionId: string, ownerId: string | null): string | null {
  const db = getDb();
  const pending = db
    .prepare(`SELECT 1 AS ok FROM pk_invites WHERE session_id = ? AND status = 'pending' LIMIT 1`)
    .get(sessionId);
  if (pending) {
    return '本会话已有一张**未答复**的对战邀请挂在屏幕上。他没点就等于现在不想打——别再发第二张，继续正常讲题。';
  }
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pk_invites WHERE session_id = ? AND created_at > datetime('now', ?)`,
    )
    .get(sessionId, sqliteAgo(PK_INVITE_SESSION_COOLDOWN_MS)) as { n: number };
  if (recent.n > 0) {
    return `距本会话上一张对战邀请不足 ${Math.round(PK_INVITE_SESSION_COOLDOWN_MS / 60_000)} 分钟，这次不发。不要把「没发出去」当成失败重试，继续正常回答即可。`;
  }
  if (ownerId !== null) {
    const daily = db
      .prepare(
        `SELECT COUNT(*) AS n FROM pk_invites WHERE owner_id = ? AND created_at > datetime('now', '-1 day')`,
      )
      .get(ownerId) as { n: number };
    if (daily.n >= PK_INVITE_OWNER_DAILY_MAX) {
      return `这位学习者 24 小时内已经收到 ${PK_INVITE_OWNER_DAILY_MAX} 局对战邀请，今天不再发邀请。`;
    }
  }
  return null;
}

// ── 对外动作 ─────────────────────────────────────────────

export type InviteResult = { ok: true; record: PkInviteRecord } | { ok: false; code: PkInviteError; error: string };

export interface OfferInviteInput {
  sessionId: string;
  /** null＝本地单人形态无主（`ownerIdOf → null` 同语义）。⇒ 人维度那条闸门只在有主时数得准 */
  ownerId: string | null;
  /** 收 unknown：截断与空值校验在 shared 的纯函数里做，调用方直通即可 */
  topic: unknown;
  reason: unknown;
}

/**
 * 模型发出邀请：归一 → 闸门 → 落库 → 广播 ⇒ **立即返回，不等待答复**（文件头那条取舍）。
 *
 * 截断发生在**这一刻**而不是用户点「接受」时（契约 §16.3）：留到点接受才校验，
 * 报错就落在用户已经做完决定之后——那是最坏的时机。
 */
export function offerPkInvite(input: OfferInviteInput): InviteResult {
  // 空 sessionId 会让卡片发到一个不存在的频道上：写库成功、广播无人收，症状是「AI 说发了，屏幕上没有」
  if (!input.sessionId) return { ok: false, code: 'INVITE_INPUT_INVALID', error: 'sessionId 缺失：无法把邀请卡挂到任何会话上' };
  const norm = normalizePkInviteInput({ topic: input.topic, reason: input.reason });
  if (!norm.ok) return { ok: false, code: 'INVITE_INPUT_INVALID', error: norm.error };

  const blocked = gateBlock(input.sessionId, input.ownerId);
  if (blocked) return { ok: false, code: 'INVITE_THROTTLED', error: blocked };

  const record: PkInviteRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    ownerId: input.ownerId,
    topic: norm.topic,
    reason: norm.reason,
    status: 'pending',
    roomId: null,
    createdAt: Date.now(),
  };
  insertInvite(record);
  publish(input.sessionId, { type: 'pk-invite-asked', sessionId: input.sessionId, invite: record });
  return { ok: true, record };
}

/**
 * 未答复的邀请（前端刷新/重连后把卡捞回来用）。
 * ★ 读侧判旧：超过 `PK_ROOM_TTL_MS`（30 分钟，与房间 waiting 同档、复用常量不新造）就不再浮出——
 *   状态机里没有 `expired`（§16.4），所以这条 WHERE 是**唯一**的「别让旧卡骚扰人」的地方。
 */
export function listPendingInvites(sessionId: string): PkInviteRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM pk_invites
       WHERE session_id = ? AND status = 'pending' AND created_at > datetime('now', ?)
       ORDER BY created_at, rowid`,
    )
    .all(sessionId, sqliteAgo(PK_ROOM_TTL_MS)) as InviteRow[];
  return rows.map(toRecord);
}

export type AcceptResult =
  | { ok: true; record: PkInviteRecord; state: PkRoomState }
  | { ok: false; code: PkInviteError; error: string };

/**
 * 用户点「接受」：建一间他自己的 PVE 房并按邀请主题开局（§16.8）。
 *
 * ★ **幂等**：同一张卡第二次点接受**返回第一次那间房**，不是 409——重复点是误触不是意图
 *   （与 `createRoom` 对 waiting 房的取向逐字同源）。并发双点时败者也走这条：`markAccepted`
 *   只有 changes=1 的那只手建房，另一只手读到已 accepted 的行后**复用它的 room_id**。
 * ⚠️ `room_id` 指的是内存房：发版重启后指不到东西 ⇒ 按 `INVITE_ROOM_GONE` 如实报，
 *   卡片文案要能自解释（§16.12 风险 5），不许让前端转圈。
 */
export function acceptPkInvite(id: string, identity: PkIdentity, ownerId: string | null): AcceptResult {
  const row = ownedRow(id, ownerId);
  if (!row) return notFound();

  if (row.status === 'accepted') {
    return row.room_id
      ? existingRoom(row)
      : { ok: false, code: 'INVITE_ROOM_GONE', error: '这场对战已结束或已失效' };
  }
  if (row.status !== 'pending') {
    return { ok: false, code: 'INVITE_NOT_PENDING', error: '这张邀请卡已被拒绝，不能再接受' };
  }

  const state = acceptInviteRoom(identity, row.topic);
  if (!markAccepted(id, state.roomId)) {
    // 并发双点：另一只手先落库了，复用它那间房（绝不覆盖 room_id）
    return existingRoom(selectById(id)!);
  }
  const after = toRecord(selectById(id)!);
  publish(row.session_id, {
    type: 'pk-invite-decided',
    sessionId: row.session_id,
    inviteId: id,
    status: 'accepted',
    roomId: state.roomId, // 另一端据此把回执卡变成「进入对局」，不然它只有一句"已开始"
  });
  return { ok: true, record: after, state };
}

export type DecideResult = { ok: true; record: PkInviteRecord } | { ok: false; code: PkInviteError; error: string };

/** 用户点「拒绝」：只置终态，不删行（行留着给闸门数「本会话刚发过邀请」） */
export function rejectPkInvite(id: string, ownerId: string | null): DecideResult {
  const row = ownedRow(id, ownerId);
  if (!row) return notFound();
  if (!markRejected(id)) {
    const now = selectById(id);
    if (!now || !ownedRow(id, ownerId)) return notFound();
    return {
      ok: false,
      code: 'INVITE_NOT_PENDING',
      error: now.status === 'accepted' ? '这场对战已经开始，无法再拒绝' : '这张邀请卡已经处理过了',
    };
  }
  const after = toRecord(selectById(id)!);
  // roomId 恒 null：拒绝不建房，帧形状与 accepted 支保持一致（前端不必按状态换字段名）
  publish(row.session_id, { type: 'pk-invite-decided', sessionId: row.session_id, inviteId: id, status: 'rejected', roomId: null });
  return { ok: true, record: after };
}

/** 已 accepted 但内存房没了（TTL 回收或重启）：如实报，不重建那局（重建＝凭空多一局他没打算打的对战） */
function existingRoom(row: InviteRow): AcceptResult {
  const state = getRoomState(row.room_id ?? '');
  if (!state) return { ok: false, code: 'INVITE_ROOM_GONE', error: '这场对战已结束或已失效，请让 AI 重新邀请一局' };
  return { ok: true, record: toRecord(row), state };
}

// ── 归属门面（§16.12 风险 6）─────────────────────────────

/**
 * 取行并核归属，两条不满足一律同一个「不存在」：
 * ★ 「不存在」与「不是你的」合成一个码（与 `MATCH_NOT_FOUND` 同取向）——分开写等于把
 *   「这条 id 确实存在」告诉了没权限的人。
 * ★ 会话归属走 `canAccessSession` 同一条门面：`ownerIdOf → null` 那条老坑（无过滤＝看全部）
 *   在这里的表现是「未登录时把别人的邀请捞出来」，所以**两条都要查**，不只查 `owner_id`。
 */
function ownedRow(id: string, ownerId: string | null): InviteRow | null {
  const row = id ? selectById(id) : undefined;
  if (!row) return null;
  if (ownerId !== null && (row.owner_id ?? '') !== ownerId) return null;
  if (!canAccessSession(row.session_id, ownerId)) return null;
  return row;
}

const notFound = (): { ok: false; code: PkInviteError; error: string } => ({
  ok: false,
  code: 'INVITE_NOT_FOUND',
  error: '邀请不存在或已失效',
});

/** 工具回灌文本（成功分支；被闸门挡下的文案在 `gateBlock` 里，两处不各写一份） */
export function inviteToolHint(record: PkInviteRecord): string {
  return (
    `已向学习者发出对战邀请（主题「${record.topic}」），卡片显示在他的输入框上方，` +
    `他可以随时接受或拒绝，**你不需要等他**。本轮请正常收尾，不要重复提问、也不要再发同一张卡。`
  );
}
