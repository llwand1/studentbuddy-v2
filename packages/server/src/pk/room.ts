/**
 * pk/room — PK 房间状态机（契约 docs/PK-SPEC.md §2/§4，P0-1）。
 *
 * 存储刻意从简（契约 §4）：**全内存 Map，无落库、无 schema 改动**——局域网单进程 demo 足够，
 * 进程重启即丢局（已在企划声明并接受）。P1 才引 pk_rooms 等表与战绩。
 *
 * 单一事实源纪律：所有计时（对局时钟、P0-2 起的 CD/答题时限/怠慢惩罚）都在服务端，
 * 客户端时间只作展示——防作弊不靠客户端自律。
 *
 * ★ 本文件**不含结算**：start 只置 endsAt；时钟归零后判胜负属 P0-2（届时要出 winner）。
 *   P0-1 对 active 房的唯一处理是 TTL 回收，不擅自写 winner。
 */
import { randomUUID } from 'node:crypto';
import {
  AI_FIRST_QUIZ_DELAY_MS,
  AI_USER_PREFIX,
  HELP_PER_MATCH,
  PK_DEFAULT_AI_TOPIC,
  PK_FINISHED_KEEP_MS,
  PK_MATCH_MS,
  PK_MAX_PLAYERS,
  PK_ROOM_CODE_LEN,
  PK_ROOM_TTL_MS,
  TOPIC_MAX,
  isAiUserId,
  type PkEndReason,
  type PkQuizPending,
  type PkIdentity,
  type PkMode,
  type PkPlayer,
  type PkQuestion,
  type PkRoomError,
  type PkRoomState,
  type PkRoomStatus,
} from '@sb/shared';

/** 房内题目：快照形状 + 服务端私有的正确答案。`answer` **永不**进任何对外载荷（契约 §1） */
export interface PkRoomQuestion extends PkQuestion {
  answer: number;
}

export interface Room {
  roomId: string;
  /** 6 位房号；与 roomId 分离——房号要能被人口头念出来，roomId 不必 */
  code: string;
  status: PkRoomStatus;
  /** pvp / pve（PVE 的第二座位在建房时即由 AI 占据） */
  mode: PkMode;
  /** PVE 可选主题方向；空 = AI 自选轮换 */
  aiTopic?: string;
  /** 按入房顺序，`[0]` 即房主 */
  players: PkPlayer[];
  endsAt: number;
  /** 开局时刻：怠慢惩罚的初始锚点（首 120s 宽限从开局起算） */
  startedAt: number;
  /** 各玩家怠慢惩罚锚点：距锚 ≥ IDLE_PENALTY_MS 且无成功出题 → −1，锚前移一个窗口（可累计） */
  idleAnchor: Record<string, number>;
  /** P0-1 恒空；P0-2 出题后填充（结构先定，前端零改动） */
  questions: PkRoomQuestion[];
  nextQuizAt: Record<string, number>;
  /** PVE：AI 下一题时刻；出题失败 = now + AI_RETRY_DELAY_MS（失败不计 CD 不扣分） */
  aiNextQuizAt: number;
  /** PVE：AI 出题在途标志（防 1s ticker 重复触发） */
  aiBusy: boolean;
  /** PVE：AI 自选主题的轮换游标（随机起点） */
  aiTopicIdx: number;
  /** P0-7：当前轮次主题——**谁出题都必须贴合它**；每成功出一道题切到另一方的主题 */
  currentTopic: string;
  /** P0-7：当前主题归属的 userId（决定下次切给谁） */
  topicOwnerId: string;
  /** P0-7：已成功出题数（主题轮转游标） */
  topicTurn: number;
  /** P0-7：各玩家二次机会解锁时刻（ms）；未用过无此键 */
  retryNextAt: Record<string, number>;
  winner?: string;
  /** P0-8：仅 `forfeit`（认输）时置位——`timeup` 不写，保持「老字段语义不变」 */
  endReason?: PkEndReason;
  /**
   * UX 批：正在 AI 出题的人（出题开始置位、生成完或失败即清除）。
   * ★ 放房间状态里（而不是单发一条 SSE 事件）是为了**刷新回来仍在**——
   *   事件是瞬时的，刷新就丢；状态是持久的，重连拿快照就知道「对手还在出题」。
   */
  quizPending?: PkQuizPending;
  /** 最近一次状态变更时刻（ms）：TTL 回收判据 */
  lastActivity: number;
}

const rooms = new Map<string, Room>();
/** 房号 → roomId 反查表（入房凭证查找；房间删除时必须同步清理） */
const codes = new Map<string, string>();

function fail(code: PkRoomError): never {
  throw new Error(code);
}

/**
 * 房间过期时刻（ms）。
 * ★ 契约 §4 原文「finished/waiting 超 30 分钟回收；对局结束快照保留 10 分钟供双方回看」——
 * 后半句是对 finished 的收紧，故此处按「waiting 30 分钟 / finished 10 分钟」解读（两种读法不并存）。
 * active 取「对局时钟 + 保留期」：P0-1 不结算，过期只回收，不改写 winner。
 */
function expiryOf(room: Room): number {
  if (room.status === 'waiting') return room.lastActivity + PK_ROOM_TTL_MS;
  if (room.status === 'finished') return room.lastActivity + PK_FINISHED_KEEP_MS;
  return room.endsAt + PK_FINISHED_KEEP_MS;
}

/**
 * 惰性回收过期房间（每次入口调用一次，不起定时器——P0 只需「不会无界增长」，
 * 不需要「到期那一刻就消失」；无活动时不过期也无人受影响）。
 */
export function sweepExpired(now = Date.now()): number {
  let removed = 0;
  for (const [roomId, room] of [...rooms]) {
    if (now < expiryOf(room)) continue;
    rooms.delete(roomId);
    codes.delete(room.code);
    removed += 1;
  }
  return removed;
}

/** 建座位。P0-7 起带三件新状态：本人主题（开局前可改）、求助道具余额、出题失败计数 */
function toPlayer(identity: PkIdentity, topic = ''): PkPlayer {
  return {
    userId: identity.userId,
    nickname: identity.nickname,
    score: 0,
    correct: 0,
    answered: 0,
    lastQuizAt: 0,
    topic,
    helpLeft: HELP_PER_MATCH,
    failStreak: 0,
  };
}

/** 派生对外快照：players/questions 逐层复制，防调用方改到内部状态。
 *  ★ `answer` 只在题目已判定（answered/timeout）时以 `answerRevealed` 名义下发；
 *    pending 题连键都没有——「正确答案永不下发」在结构层面成立（契约 §1）。 */
// ── UX 批：出题中标记（2026-09-15 老板点单「对面出题能不能给个过渡」）────────

/**
 * 置「出题中」标记。**出题开始即调用**（在 `await` 生成之前），让答题方立刻看到提示。
 * ★ 放 room.ts 而不是在 match.ts 内联：① 房间状态的操作该由状态机自己管；
 *   ② `match.ts` 已贴 400 行门禁，内联会把它顶破。
 */
export function setQuizPending(room: Room, userId: string, at: number): void {
  room.quizPending = { userId, at };
}

/**
 * 清「出题中」标记。★ **跑题／生成失败／成功三条出口都必须调**——漏一条，
 * 对手就会永远看到「正在出题」，那比当初干脆不给这个信号还糟（他会以为卡死了）。
 */
export function clearQuizPending(room: Room): void {
  delete room.quizPending;
}

export function snapshotRoom(room: Room): PkRoomState {
  const state: PkRoomState = {
    roomId: room.roomId,
    roomCode: room.code,
    status: room.status,
    mode: room.mode,
    players: room.players.map((p) => ({ ...p })),
    nextQuizAt: { ...room.nextQuizAt },
    endsAt: room.endsAt,
    questions: room.questions.map((q) => {
      const base: PkQuestion = {
        id: q.id,
        roomId: q.roomId,
        fromUserId: q.fromUserId,
        toUserId: q.toUserId,
        prompt: q.prompt,
        stem: q.stem,
        options: [...q.options],
        createdAt: q.createdAt,
        deadlineAt: q.deadlineAt,
        status: q.status,
      };
      if (q.chosen !== undefined) base.chosen = q.chosen;
      if (q.status !== 'pending') base.answerRevealed = q.answer;
      if (q.topic) base.topic = q.topic;
      if (q.retryOf) base.retryOf = q.retryOf;
      if (q.isRetry) base.isRetry = true;
      return base;
    }),
    currentTopic: room.currentTopic,
    topicOwnerId: room.topicOwnerId,
    topicTurn: room.topicTurn,
    retryNextAt: { ...room.retryNextAt },
  };
  if (room.aiTopic) state.aiTopic = room.aiTopic;
  if (room.winner) state.winner = room.winner;
  if (room.endReason) state.endReason = room.endReason;
  // UX 批：出题中（公开事实，双方都该看到「谁在出题」）
  if (room.quizPending) state.quizPending = room.quizPending;
  return state;
}

/** 该用户当前所在的 waiting 房（契约 §2.1：每人同时只能有 1 个 waiting 房） */
function findWaitingRoomOf(userId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.status !== 'waiting') continue;
    if (room.players.some((p) => p.userId === userId)) return room;
  }
  return undefined;
}

/** 把用户从其它 waiting 房里摘掉（房空了就删）；**不动 active/finished 房**——对局中的席位不能被建新房顺手清掉 */
function leaveWaitingRooms(userId: string): void {
  for (const [roomId, room] of [...rooms]) {
    if (room.status !== 'waiting') continue;
    if (!room.players.some((p) => p.userId === userId)) continue;
    room.players = room.players.filter((p) => p.userId !== userId);
    room.lastActivity = Date.now();
    if (room.players.length === 0) {
      rooms.delete(roomId);
      codes.delete(room.code);
    }
  }
}

/** 生成不碰撞的 6 位房号 */
function genCode(): string {
  for (let i = 0; i < 100; i += 1) {
    const code = String(Math.floor(Math.random() * 10 ** PK_ROOM_CODE_LEN)).padStart(PK_ROOM_CODE_LEN, '0');
    if (!codes.has(code)) return code;
  }
  return fail('ROOM_CODE_EXHAUSTED');
}

function requireRoom(roomIdRaw: unknown): Room {
  const roomId = typeof roomIdRaw === 'string' ? roomIdRaw : '';
  const room = rooms.get(roomId);
  if (!room) fail('ROOM_NOT_FOUND');
  return room;
}

/**
 * 建房。幂等：已在某 waiting 房（含自己建的、或已入的）则**返回原房**而不是报错——
 * 重复点「建房」是误触不是意图，报错只会让人以为坏了（产品取向：体验感优先）。
 * PVE（mode='pve'）：第二个座位建房即由 AI 占据（`ai-<roomId>`），此后人再输码入房会被满员挡下——
 * 人机局天然只有一个人。
 */
export function createRoom(identity: PkIdentity, mode: PkMode = 'pvp', aiTopic?: string, topic?: string): PkRoomState {
  const now = Date.now();
  sweepExpired(now);
  const existing = findWaitingRoomOf(identity.userId);
  if (existing) {
    existing.lastActivity = now;
    return snapshotRoom(existing);
  }
  const room: Room = {
    roomId: `r-${randomUUID()}`,
    code: genCode(),
    status: 'waiting',
    mode,
    // 建房时顺带定主题：省掉「建房→再调一次 setTopic」的往返（入房的人走 setTopic 端点补选）
    players: [toPlayer(identity, topic?.trim().slice(0, TOPIC_MAX) ?? '')],
    endsAt: 0,
    startedAt: 0,
    idleAnchor: {},
    questions: [],
    nextQuizAt: {},
    aiNextQuizAt: 0,
    aiBusy: false,
    aiTopicIdx: Math.floor(Math.random() * 32),
    currentTopic: '',
    topicOwnerId: '',
    topicTurn: 0,
    retryNextAt: {},
    lastActivity: now,
  };
  if (mode === 'pve') {
    if (aiTopic?.trim()) room.aiTopic = aiTopic.trim().slice(0, 50);
    // AI 座位也是一个「玩家」：主题用建房填的方向（空串则由开局的主题缺省逻辑兜底）
    room.players.push(
      toPlayer({ userId: `${AI_USER_PREFIX}${room.roomId}`, nickname: 'AI 对手' }, room.aiTopic?.slice(0, TOPIC_MAX) ?? ''),
    );
  }
  rooms.set(room.roomId, room);
  codes.set(room.code, room.roomId);
  return snapshotRoom(room);
}

/**
 * 按房号入房。重复入同一间房幂等；**校验全部通过后才摘旧房**——
 * 否则一次失败的入房会把人从自己原来的房里踢出去。
 */
export function joinRoom(roomCodeRaw: unknown, identity: PkIdentity): PkRoomState {
  const now = Date.now();
  sweepExpired(now);
  const code = typeof roomCodeRaw === 'string' ? roomCodeRaw.trim() : '';
  const roomId = codes.get(code);
  const room = roomId ? rooms.get(roomId) : undefined;
  if (!room) fail('ROOM_NOT_FOUND');
  if (room.players.some((p) => p.userId === identity.userId)) {
    room.lastActivity = now;
    return snapshotRoom(room);
  }
  if (room.status !== 'waiting') fail('ROOM_NOT_WAITING');
  if (room.players.length >= PK_MAX_PLAYERS) fail('ROOM_FULL');
  leaveWaitingRooms(identity.userId);
  room.players.push(toPlayer(identity));
  room.lastActivity = now;
  return snapshotRoom(room);
}

/**
 * P0-7：选定本人对战主题（仅 waiting 期可改——开局后改主题等于中途改规则）。
 * 主题不参与胜负，只决定「轮到这一轮时你该出什么题」：当前轮次主题在你与对方的两主题之间交替，
 * **谁出题都必须贴合它**，跑题判失败（判罚与重试见 match.ts）。
 */
export function setTopic(roomIdRaw: unknown, identity: PkIdentity, rawTopic: unknown): PkRoomState {
  const now = Date.now();
  sweepExpired(now);
  const room = requireRoom(roomIdRaw);
  const me = room.players.find((p) => p.userId === identity.userId);
  if (!me) fail('NOT_A_PLAYER');
  if (room.status !== 'waiting') fail('ROOM_NOT_WAITING');
  if (typeof rawTopic !== 'string' || !rawTopic.trim()) fail('TOPIC_INVALID');
  me.topic = rawTopic.trim().slice(0, TOPIC_MAX);
  room.lastActivity = now;
  return snapshotRoom(room);
}

/**
 * 开局。仅房主可开（`players[0]`），且双方都已进房才置 active、`endsAt = now + 8 分钟`。
 * ★ 「双方在线」在 P0 的实现口径＝**两人已在房内**（不追连接态）：内存模型里没有心跳，
 *   真做在线判定要等 P1 落库 + 连接追踪，届时应替换此处判据而不是加个假标志位。
 */
export function startRoom(roomIdRaw: unknown, identity: PkIdentity): PkRoomState {
  const now = Date.now();
  sweepExpired(now);
  const room = requireRoom(roomIdRaw);
  // 先判身份再判状态：非房主撞上已开局，给 403 比 409 更准确
  if (room.players[0]?.userId !== identity.userId) fail('NOT_ROOM_OWNER');
  if (room.status !== 'waiting') fail('ROOM_NOT_WAITING');
  if (room.players.length < PK_MAX_PLAYERS) fail('ROOM_NOT_READY');
  // P0-7：没主题就无从判定「出题是否跑题」⇒ 开局前双方必须都选定。
  // AI 座位是例外——它不会自己去填表单，建房没指定方向时给个通用主题，不拿这个卡住房主。
  for (const p of room.players) {
    if (p.topic.trim()) continue;
    if (isAiUserId(p.userId)) p.topic = PK_DEFAULT_AI_TOPIC;
    else fail('TOPIC_NOT_SET');
  }
  room.status = 'active';
  room.endsAt = now + PK_MATCH_MS;
  room.startedAt = now;
  // 首轮用房主（players[0]）的主题；每成功出一道题由 match 侧切到另一方
  room.topicTurn = 0;
  room.topicOwnerId = room.players[0]?.userId ?? '';
  room.currentTopic = room.players[0]?.topic ?? '';
  // 怠慢锚点从开局起算：双方开局后都有 120s 宽限去完成第一次成功出题
  for (const p of room.players) room.idleAnchor[p.userId] = now;
  // PVE：AI 第一题在开局 + AI_FIRST_QUIZ_DELAY_MS（ticker 到点触发）
  room.aiNextQuizAt = room.mode === 'pve' ? now + AI_FIRST_QUIZ_DELAY_MS : 0;
  room.aiBusy = false;
  room.lastActivity = now;
  return snapshotRoom(room);
}

/** 读房间快照（断线重连对齐用）；不存在/已回收 → null（路由转 404） */
export function getRoomState(roomIdRaw: unknown): PkRoomState | null {
  sweepExpired();
  const roomId = typeof roomIdRaw === 'string' ? roomIdRaw : '';
  const room = rooms.get(roomId);
  return room ? snapshotRoom(room) : null;
}

// ── 内部访问器（仅供同包 match/ai-bot 与测试使用；路由层一律走快照）────────

/** 取内部 Room（含 answer 等私有字段）；不存在即抛 ROOM_NOT_FOUND */
export function requireRoomInternal(roomIdRaw: unknown): Room {
  return requireRoom(roomIdRaw);
}

/** 内部房是否存在（AI 异步回写前的防悬挂检查：房可能已被 TTL 回收） */
export function hasActiveRoom(roomId: string): boolean {
  const room = rooms.get(roomId);
  return room !== undefined && room.status === 'active';
}

/** 全部内部房（ticker 遍历用） */
export function allRoomsInternal(): Room[] {
  return [...rooms.values()];
}

/** 测试辅助：清空全部房间（进程内单例，用例间必须隔离） */
export function resetRooms(): void {
  rooms.clear();
  codes.clear();
}
