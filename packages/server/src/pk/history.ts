/**
 * pk/history — 对战历史（契约 docs/PK-SPEC.md §12.2，P0-8，2026-09-14 老板点单）。
 *
 * ★ 本文件是 **P0 里第一处让对局落库**的地方（v15 迁移建 `pk_matches`）。房间状态机仍是
 *   全内存（`room.ts` 口径不变）：房间是**过程**（进程内活着就够），历史是**结果**
 *   （重启后还得能查）。只有「已经结束的一局」被摘成行写进来。
 *
 * ★ **视角行**（每人一行）而非「一局一行 + 两个玩家字段」：历史永远是「按人查」的
 *   （`WHERE user_id=? ORDER BY ended_at DESC`），视角行让这条查询直接走索引、前端也不必
 *   每次自己算「我是哪一侧」。代价是 PVP 一局存两行、快照 JSON 各存一份（一局几 KB）——
 *   与 `quiz_notes` 冗余 `quiz_title` 同一取向：**快照冗余换查询简单**。
 *
 * ★ **只给真人写行**：`ai-<roomId>` 永远不会登录来查战绩，给它写行只是往库里塞孤儿数据。
 *
 * ★ 本文件**只依赖 shared + db**（收尾时由 `finishRoom` 把快照递进来），不 import `room.js`——
 *   少一层依赖就少一个成环的机会（PK_QUIZ_MIX 那次的教训）。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PK_HISTORY_KEEP,
  PK_HISTORY_LIMIT,
  PK_HISTORY_MAX,
  isAiUserId,
  type PkEndReason,
  type PkMatchDetail,
  type PkMatchRecord,
  type PkOutcome,
  type PkRoomState,
} from '@sb/shared';
import { getDb } from '../storage/db.js';

/** 库里的行形状（snake_case 只活在本文件；对外一律经 `toRecord` 折算成契约类型） */
interface Row {
  id: string;
  room_id: string;
  user_id: string;
  opponent_id: string;
  opponent_nickname: string;
  mode: string;
  my_score: number;
  opp_score: number;
  outcome: string;
  reason: string;
  quiz_count: number;
  ended_at: number;
}

const COLUMNS = `id, room_id, user_id, opponent_id, opponent_nickname, mode, my_score, opp_score, outcome, reason, quiz_count, ended_at`;

/** 胜负折算：没有 winner = 平局（只有时钟归零才可能平，投降必分胜负）。 */
function outcomeOf(state: PkRoomState, meId: string): PkOutcome {
  if (!state.winner) return 'draw';
  return state.winner === meId ? 'win' : 'lose';
}

/** 库值 → 契约值：**逐字段回落**而不是 `as`（库里出现没见过的字面量时，宁可显示「平局」也不让脏值漏到前端） */
function toOutcome(raw: string): PkOutcome {
  return raw === 'win' || raw === 'lose' ? raw : 'draw';
}

function toReason(raw: string): PkEndReason {
  return raw === 'forfeit' ? 'forfeit' : 'timeup';
}

/** 每人只留最新 `PK_HISTORY_KEEP` 条（超出删最旧）：房间有 TTL 防内存无界增长，历史同理 */
function pruneOldest(d: Database.Database, userId: string): void {
  d.prepare(
    `DELETE FROM pk_matches WHERE id IN (
       SELECT id FROM pk_matches WHERE user_id = ?
       ORDER BY ended_at DESC, rowid DESC LIMIT -1 OFFSET ?
     )`,
  ).run(userId, PK_HISTORY_KEEP);
}

/**
 * 落一局历史。**由 `finishRoom` 在广播 `pk-end` 之后调用**（先让人看见结果、再落库）。
 *
 * ★ 写失败**不影响对局收尾**（ADR-4：旁挂能力不拖垮主路径——历史没写成不该让结算变成 500）。
 *   但**必须留痕**：静默失败会让「历史少了几局」变成查不出来的悬案（ADR-5 不静默）。
 * ★ 幂等由库保证：`UNIQUE(room_id, user_id)` + `INSERT OR IGNORE`——不靠调用方记得只调一次。
 */
export function recordMatch(state: PkRoomState, reason: PkEndReason, now: number): void {
  try {
    const humans = state.players.filter((p) => !isAiUserId(p.userId));
    if (humans.length === 0) return;
    const d = getDb();
    const insert = d.prepare(
      `INSERT OR IGNORE INTO pk_matches (${COLUMNS}, snapshot_json)
       VALUES (@id, @room_id, @user_id, @opponent_id, @opponent_nickname, @mode, @my_score,
               @opp_score, @outcome, @reason, @quiz_count, @ended_at, @snapshot_json)`,
    );
    const snapshotJson = JSON.stringify(state);
    const write = d.transaction(() => {
      for (const me of humans) {
        const opp = state.players.find((p) => p.userId !== me.userId);
        if (!opp) continue;
        insert.run({
          id: randomUUID(),
          room_id: state.roomId,
          user_id: me.userId,
          opponent_id: opp.userId,
          opponent_nickname: opp.nickname,
          mode: state.mode,
          my_score: me.score,
          opp_score: opp.score,
          outcome: outcomeOf(state, me.userId),
          reason,
          quiz_count: state.questions.length,
          ended_at: now,
          snapshot_json: snapshotJson,
        });
        pruneOldest(d, me.userId);
      }
    });
    write();
  } catch (e) {
    console.error('[sb-pk] 对战历史落库失败（本局结果照常生效）:', e);
  }
}

/** limit 归一：缺省/非法 → `PK_HISTORY_LIMIT`；负数钳 1；超过 `PK_HISTORY_MAX` 钳到上限 */
export function clampHistoryLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return PK_HISTORY_LIMIT;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return PK_HISTORY_LIMIT;
  return Math.min(PK_HISTORY_MAX, Math.max(1, Math.floor(n)));
}

function toRecord(r: Row): PkMatchRecord {
  return {
    id: r.id,
    roomId: r.room_id,
    mode: r.mode === 'pve' ? 'pve' : 'pvp',
    opponentId: r.opponent_id,
    opponentNickname: r.opponent_nickname,
    myScore: r.my_score,
    oppScore: r.opp_score,
    outcome: toOutcome(r.outcome),
    reason: toReason(r.reason),
    quizCount: r.quiz_count,
    endedAt: r.ended_at,
  };
}

/** 我的历史，最近的在前。userId 缺失返空表（未登录不该看到任何人的历史）。 */
export function listMatches(userIdRaw: unknown, limitRaw?: unknown): PkMatchRecord[] {
  const userId = typeof userIdRaw === 'string' ? userIdRaw : '';
  if (!userId) return [];
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM pk_matches WHERE user_id = ? ORDER BY ended_at DESC, rowid DESC LIMIT ?`)
    .all(userId, clampHistoryLimit(limitRaw)) as Row[];
  return rows.map(toRecord);
}

/**
 * 历史详情（含末快照，供题目回看）。
 * ★ **id 与 user_id 同查**：别人的记录与不存在的记录走同一条 404，不告诉无权限的人「这个 id 存在」。
 * ★ 快照解析失败**不兜底造假**：宁可 500（路由层把非域错误映射成 500），
 *   也不返回一份「没有题目的空局」——那会让坏数据看起来像正常的一局。
 */
export function getMatchDetail(idRaw: unknown, userIdRaw: unknown): PkMatchDetail | null {
  const id = typeof idRaw === 'string' ? idRaw : '';
  const userId = typeof userIdRaw === 'string' ? userIdRaw : '';
  if (!id || !userId) return null;
  const row = getDb()
    .prepare(`SELECT ${COLUMNS}, snapshot_json FROM pk_matches WHERE id = ? AND user_id = ?`)
    .get(id, userId) as (Row & { snapshot_json: string }) | undefined;
  if (!row) return null;
  return { ...toRecord(row), snapshot: JSON.parse(row.snapshot_json) as PkRoomState };
}

/** 测试辅助：清空历史（用例间隔离；库本身已按 SB_DATA_DIR 隔离，这里只清表） */
export function resetMatches(): void {
  getDb().prepare('DELETE FROM pk_matches').run();
}
