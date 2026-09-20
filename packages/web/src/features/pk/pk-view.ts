/**
 * pk-view — PK 页面纯逻辑（契约 docs/PK-SPEC.md §5）。
 *
 * 判定逻辑一律放这里、组件只负责挂——本仓 .tsx 无测试环境（先例 doc-name.ts），
 * 纯函数才能进测链路。全部无副作用、无时钟依赖：now 一律由调用方传入。
 */
import {
  isAiUserId,
  PK_ROOM_CODE_LEN,
  type PkEndReason,
  type PkOutcome,
  type PkQuestion,
  type PkRoomState,
} from '@sb/shared';

/** 房号输入归一：只留数字、截到 6 位（contract §2.1 roomCode = 6 位数字） */
export function normalizeRoomCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, PK_ROOM_CODE_LEN);
}

/**
 * §14.2 邀请码解析：从 location.hash 里取 `#/pk?code=123456` 的 code。
 * ★ query 在 **hash 片段内**，`location.search`（`#` 之前的部分）取不到——契约明钉的坑。
 * 归一复用 normalizeRoomCode：非数字 / 超长一律截好，缺省空串 = 链接没带码。
 */
export function pkInviteCodeFromHash(hash: string): string {
  const query = hash.split('?')[1] ?? '';
  return normalizeRoomCode(new URLSearchParams(query).get('code') ?? '');
}

/**
 * §14.2 拼邀请链接：本站同路径 + hash 带码（A 建房后复制/分享给 B）。
 * ★ `loc` 参数供测试注入（本仓 .ts 测试无 DOM，`window` 不存在）；运行时走默认值。
 */
export function buildPkInviteLink(
  code: string,
  loc: { origin: string; pathname: string } = window.location,
): string {
  return `${loc.origin}${loc.pathname}#/pk?code=${encodeURIComponent(code)}`;
}

/**
 * §14.3 returnTo 白名单：**只允许 `#/` 开头的站内 hash**，其余（绝对 URL / 裸路径）一律丢弃。
 * 这是开放重定向的闸门——钓鱼链接不能借本站登录页跳去外站。
 */
export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  return raw && raw.startsWith('#/') ? raw : null;
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

// ── P0-8：投降 / 对战历史（契约 §12）─────────────────────────

/**
 * 回看一题的判词。
 * ★ 必须**显式**处理 `pending`：对局在时钟归零那一刻可能还有题没答也没判超时，
 *   此时 `chosen` 与 `answerRevealed` **双双 undefined**，而旧写法 `chosen === answerRevealed`
 *   恰好为 true ⇒ 屏幕上把「还没答」显示成「答对 +2」（2026-09-14 随历史回看一并修掉；
 *   `PkRoom` 的 finished 回看与历史详情共用本函数，两边不会再各判一套）。
 */
export function reviewVerdict(q: PkQuestion): { text: string; ok: boolean } {
  if (q.status === 'pending') return { text: '未作答', ok: false };
  if (q.status === 'timeout') return { text: '超时 −1', ok: false };
  const ok = q.chosen !== undefined && q.chosen === q.answerRevealed;
  return { text: ok ? '答对 +2' : '答错 −1', ok };
}

/** 历史行的胜负文案（我的视角） */
export function outcomeLabel(outcome: PkOutcome): string {
  if (outcome === 'win') return '胜';
  if (outcome === 'lose') return '负';
  return '平';
}

/** 我在**这一份快照**里的结果（无 winner = 平）。房间结算页与历史详情共用同一判据。 */
export function myOutcome(state: PkRoomState, userId: string): PkOutcome {
  if (!state.winner) return 'draw';
  return state.winner === userId ? 'win' : 'lose';
}

/**
 * 结算页标题。认输必须单独说：只写「对局结束」，输了的人看不出「是我点了投降」
 * 还是「时间到了我分低」——那是两种完全不同的心情。
 */
export function finishTitle(state: PkRoomState, userId: string): string {
  if (state.endReason === 'forfeit') return reasonLabel('forfeit', myOutcome(state, userId));
  return state.winner ? '对局结束' : '平局';
}

/**
 * 这一局是怎么结束的（我的视角）。
 * ★ 认输必须与「时间到」分开说：赢的一方看到「对方认输」才知道是对方点了投降、
 *   而不是自己这局白打了 8 分钟；输的一方也才知道「自己认输」那一步真的生效了。
 */
export function reasonLabel(reason: PkEndReason, outcome: PkOutcome): string {
  if (reason === 'forfeit') return outcome === 'win' ? '对方认输' : '自己认输';
  return outcome === 'draw' ? '时间到 · 平局' : '时间到';
}

/** 结束时刻 → 本地「MM-DD HH:mm」；非法/缺失返空串（宁可空着，也不给用户看 Invalid Date） */
export function formatEndedAt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── UX 批（2026-09-15 老板点单：出题过渡／对错反馈／胜负仪式感）────────

/** 出题已进行的秒数（无人出题则 0）：前端据此显示「已过 Ns」，超长时好收敛文案 */
export function quizPendingSec(state: PkRoomState, now: number): number {
  const at = state.quizPending?.at;
  if (at === undefined) return 0;
  return Math.max(0, Math.floor((now - at) / 1000));
}

/**
 * 「谁正在出题」的提示；**没人在出题、或正在出题的正是我自己 → null**。
 *
 * ★ 自己出题时刻意不显示：我刚点了按钮、按钮本身就在转圈，旁边再插一条「你正在出题」
 *   等于拿提示刷存在感——**这个提示是给「看不见对方在干嘛」的那一方用的**。
 */
export function quizPendingLabel(state: PkRoomState, userId: string): { who: string; text: string } | null {
  const p = state.quizPending;
  if (!p || p.userId === userId) return null;
  // ★ 文案**只在这一处拼**，组件直接渲染 `text`、不再自己拼一遍：
  //   同一句话写两处＝迟早漂移（本仓死规矩：双真相源要么配漂移锁，要么只留一个）。
  //   这条规矩当场兑现过一次——组件里拼的是 `'AI正在出题'`、测试锁的是 `'AI 正在出题'`，
  //   两边不一致但只有一个在跑，靠断言才炸出来。
  // ★ AI 与中文之间留一个空格（中英混排规范）：'AI 正在出题' vs '对手正在出题'。
  const ai = isAiUserId(p.userId);
  return { who: ai ? 'AI' : '对手', text: ai ? 'AI 正在出题' : '对手正在出题' };
}

/**
 * 判分种类（驱动对错动画）。
 *
 * ★ 与 `reviewVerdict` **同口径**：未作答（`chosen` 与 `answerRevealed` 双双 undefined）
 *   一律**不算答对**——`chosen === answerRevealed` 的老写法就栽在这里，把「没答」显示成
 *   「答对 +2」（P0-8 已修），这里不能重蹈覆辙。
 */
export function verdictKind(q: PkQuestion): 'correct' | 'wrong' | 'timeout' | 'pending' {
  if (q.status === 'pending') return 'pending';
  if (q.status === 'timeout') return 'timeout';
  if (q.chosen === undefined || q.answerRevealed === undefined) return 'wrong';
  return q.chosen === q.answerRevealed ? 'correct' : 'wrong';
}
