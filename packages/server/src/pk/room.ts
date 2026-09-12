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
  PK_FINISHED_KEEP_MS,
  PK_MATCH_MS,
  PK_MAX_PLAYERS,
  PK_ROOM_CODE_LEN,
  PK_ROOM_TTL_MS,
  type PkIdentity,
  type PkPlayer,
  type PkQuestion,
  type PkRoomError,
  type PkRoomState,
  type PkRoomStatus,
} from '@sb/shared';

interface Room {
  roomId: string;
  /** 6 位房号；与 roomId 分离——房号要能被人口头念出来，roomId 不必 */
  code: string;
  status: PkRoomStatus;
  /** 按入房顺序，`[0]` 即房主 */
  players: PkPlayer[];
  endsAt: number;
  /** P0-1 恒空；P0-2 出题后填充（结构先定，前端零改动） */
  questions: PkQuestion[];
  nextQuizAt: Record<string, number>;
  winner?: string;
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

function toPlayer(identity: PkIdentity): PkPlayer {
  return {
    userId: identity.userId,
    nickname: identity.nickname,
    score: 0,
    correct: 0,
    answered: 0,
    lastQuizAt: 0,
  };
}

/** 派生对外快照：players/questions 逐层复制，防调用方改到内部状态 */
function toState(room: Room): PkRoomState {
  const state: PkRoomState = {
    roomId: room.roomId,
    roomCode: room.code,
    status: room.status,
    players: room.players.map((p) => ({ ...p })),
    nextQuizAt: { ...room.nextQuizAt },
    endsAt: room.endsAt,
    questions: room.questions.map((q) => ({ ...q, options: [...q.options] })),
  };
  if (room.winner) state.winner = room.winner;
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
 */
export function createRoom(identity: PkIdentity): PkRoomState {
  const now = Date.now();
  sweepExpired(now);
  const existing = findWaitingRoomOf(identity.userId);
  if (existing) {
    existing.lastActivity = now;
    return toState(existing);
  }
  const room: Room = {
    roomId: `r-${randomUUID()}`,
    code: genCode(),
    status: 'waiting',
    players: [toPlayer(identity)],
    endsAt: 0,
    questions: [],
    nextQuizAt: {},
    lastActivity: now,
  };
  rooms.set(room.roomId, room);
  codes.set(room.code, room.roomId);
  return toState(room);
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
    return toState(room);
  }
  if (room.status !== 'waiting') fail('ROOM_NOT_WAITING');
  if (room.players.length >= PK_MAX_PLAYERS) fail('ROOM_FULL');
  leaveWaitingRooms(identity.userId);
  room.players.push(toPlayer(identity));
  room.lastActivity = now;
  return toState(room);
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
  room.status = 'active';
  room.endsAt = now + PK_MATCH_MS;
  room.lastActivity = now;
  return toState(room);
}

/** 读房间快照（断线重连对齐用）；不存在/已回收 → null（路由转 404） */
export function getRoomState(roomIdRaw: unknown): PkRoomState | null {
  sweepExpired();
  const roomId = typeof roomIdRaw === 'string' ? roomIdRaw : '';
  const room = rooms.get(roomId);
  return room ? toState(room) : null;
}

/** 测试辅助：清空全部房间（进程内单例，用例间必须隔离） */
export function resetRooms(): void {
  rooms.clear();
  codes.clear();
}
