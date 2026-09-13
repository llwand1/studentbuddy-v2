/**
 * pk-view — PK 页面纯逻辑（契约 docs/PK-SPEC.md §5）。
 *
 * 判定逻辑一律放这里、组件只负责挂——本仓 .tsx 无测试环境（先例 doc-name.ts），
 * 纯函数才能进测链路。全部无副作用、无时钟依赖：now 一律由调用方传入。
 */
import { PK_ROOM_CODE_LEN, type PkQuestion, type PkRoomState } from '@sb/shared';

/** 房号输入归一：只留数字、截到 6 位（contract §2.1 roomCode = 6 位数字） */
export function normalizeRoomCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PK_ROOM_CODE_LEN);
}

/** 对局时钟剩余毫秒：已到点钳 0（客户端时间只作展示，真判罚在服务端） */
export function remainingMs(endsAt: number, now: number): number {
  return Math.max(0, endsAt - now);
}

/** 对局时钟 mm:ss（例 7:35）；一局上限 8 分钟，不会出现小时位 */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 我在房内的下标；不在房内返回 -1（房主恒为 players[0]，契约 §2.1） */
export function myIndex(state: PkRoomState, userId: string): number {
  return state.players.findIndex((p) => p.userId === userId);
}

/** 我是不是房主（唯一有权开局的人） */
export function isOwner(state: PkRoomState, userId: string): boolean {
  return myIndex(state, userId) === 0;
}

/** 我的出题 CD 剩余毫秒（未设过 = 已解锁）；钳 0，真判罚在服务端 */
export function cdRemainingMs(state: PkRoomState, userId: string, now: number): number {
  const unlockAt = state.nextQuizAt[userId] ?? 0;
  return Math.max(0, unlockAt - now);
}

/** 发给我的、还没答也没判超时的那道题（没有则 null） */
export function myPendingQuestion(state: PkRoomState, userId: string): PkQuestion | null {
  return state.questions.find((q) => q.toUserId === userId && q.status === 'pending') ?? null;
}

/** 我刚出给对手、还没被答/判超时的题（PVE 显示「对手思考中」用） */
export function pendingToOpponent(state: PkRoomState, userId: string): PkQuestion | null {
  return state.questions.find((q) => q.fromUserId === userId && q.toUserId !== userId && q.status === 'pending') ?? null;
}

/** 选项字母（A-D）；超范围返回空串（单选最多 4 项） */
export function optionLetter(i: number): string {
  return ['A', 'B', 'C', 'D'][i] ?? '';
}

/** 判定结果一行文案（含正负分，契约 §1 计分表口径） */
export function verdictText(correct: boolean, delta: number): string {
  return correct ? `答对 ${delta >= 0 ? '+' : ''}${delta}` : `答错 ${delta}`;
}

// ── P0-7：主题轮转 / 道具 / 二次机会 ─────────────────────────

/**
 * 当前轮次主题的归属文案（「你的主题」/「XX 的主题」）；还没开局返回空串。
 * ★ 主题不区分「该谁出题」——**谁出题都要贴合它**，这里只是告诉玩家这轮考谁选的领域。
 */
export function topicOwnerLabel(state: PkRoomState, userId: string): string {
  const owner = state.players.find((p) => p.userId === state.topicOwnerId);
  if (!owner) return '';
  return owner.userId === userId ? '你的主题' : `${owner.nickname} 的主题`;
}

/** 我的剩余求助道具数；不在房内返 0（不该发生，但不给默认值造假） */
export function myHelpLeft(state: PkRoomState, userId: string): number {
  return state.players.find((p) => p.userId === userId)?.helpLeft ?? 0;
}

/** 二次机会剩余冷却毫秒；从未用过 = 0（立即可用） */
export function retryRemainingMs(state: PkRoomState, userId: string, now: number): number {
  return Math.max(0, (state.retryNextAt[userId] ?? 0) - now);
}

/**
 * 可用于二次机会的错题：**我答的**且**没答对**的题。
 * 判据＝题已判定（非 pending）＋ 收题人是我 ＋ 所选 ≠ 正确答案；
 * 超时未答时 `chosen` 是 undefined，同样算「没答对」。
 */
export function myWrongQuestions(state: PkRoomState, userId: string): PkQuestion[] {
  return state.questions.filter((q) => {
    if (q.toUserId !== userId || q.status === 'pending') return false;
    return q.chosen === undefined || q.chosen !== q.answerRevealed;
  });
}
