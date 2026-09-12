/**
 * pk — AI 出题 PK 契约（docs/PK-SPEC.md，先登记再实现）。
 *
 * 批次节奏：P0-1 ＝ 登录 + 房间（建房 / 入房 / start）+ SSE `pk:` 频道（本文件当前覆盖范围）；
 * 计分相关（出题 CD / 答题时限 / 怠慢惩罚）的类型与常量随 P0-2 追加登记——
 * **不提前登记用不上的常量**，未实现的常量只会成为下一个漂移源。
 *
 * 单一事实源：常量 / 类型 / 频道键一律在此定义，server 与 web 只引用不复制。
 */

// ── 登录（P0-1）────────────────────────────────────────────

/** 登录身份（POST /api/pk/auth/login 响应 / GET /api/pk/auth/me 响应主体） */
export interface PkIdentity {
  userId: string;
  /** P0 = `mock_<userId>`；P1 替换为微信公众号网页授权真实 openid */
  openid: string;
  /** 昵称（1~20 字，trim 后非空），登录时可改名 */
  nickname: string;
}

// ── 房间常量（P0-1）────────────────────────────────────────

/** 房间人数上限：PK 是双人对战，P0 固定 2（房满即拒第 3 人） */
export const PK_MAX_PLAYERS = 2;
/** 房号位数：6 位数字。入房凭证，前端按此长度做输入校验 */
export const PK_ROOM_CODE_LEN = 6;
/** 一局时长：8 分钟（契约 §1；对局时钟在服务端，客户端时间只作展示） */
export const PK_MATCH_MS = 8 * 60_000;
/** 房间 TTL：waiting / finished 超过它即被回收（契约 §4，防内存无界增长） */
export const PK_ROOM_TTL_MS = 30 * 60_000;
/** 结束后快照保留时长：供双方回看题目（契约 §4） */
export const PK_FINISHED_KEEP_MS = 10 * 60_000;

/**
 * SSE 频道键：PK 一律走 `pk:` 前缀。
 * ★ 存在理由＝与聊天 `sessionId` **严格隔离**（v1 串台教训）：两者共用 sse-bus 实现，
 * 若房间号直接当会话 ID 用，同名两边就会互收对方事件。前端订阅时用同一个函数，不手抄前缀。
 */
export function pkChannel(roomId: string): string {
  return `pk:${roomId}`;
}

// ── 房间模型（P0-1）────────────────────────────────────────

export type PkRoomStatus = 'waiting' | 'active' | 'finished';

/**
 * 房间内一名玩家。服务端是计分唯一权威，本结构随快照下发。
 * P0-1 只用到 userId/nickname，计分三列先占位（恒 0）——快照结构一次定死，
 * P0-2 接上计分时前端零改动。
 */
export interface PkPlayer {
  userId: string;
  nickname: string;
  /** 当前积分，**可为负**（契约 §1 不设下限；P0-2 起计分） */
  score: number;
  /** 答对题数（平分时比正确率的依据） */
  correct: number;
  /** 已答题数 */
  answered: number;
  /** 上一次成功出题时刻（ms）；P0-2 起用于出题 CD 判定 */
  lastQuizAt: number;
}

/**
 * 题目（**答题方视角：不含 answer 字段**）。
 * 正确答案只活在服务端内部结构与判分逻辑里，**永不下发**（含 SSE）——契约 §1 硬约束，
 * 所以此处刻意没有 answer：类型层面就不给「不小心下发」留口子。
 */
export interface PkQuestion {
  id: string;
  roomId: string;
  fromUserId: string;
  toUserId: string;
  /** 出题提示词原文（≤300 字，服务端截断） */
  prompt: string;
  stem: string;
  options: string[];
  createdAt: number;
  /** createdAt + 答题时限；超时由服务端判罚，之后该题作废不可再答 */
  deadlineAt: number;
  status: 'pending' | 'answered' | 'timeout';
}

/** 对局快照（GET /api/pk/rooms/:id/state 响应 / SSE `pk-state` 载荷） */
export interface PkRoomState {
  roomId: string;
  /** 6 位房号：入房凭证（房号与 roomId 分离，房号可被人念出来） */
  roomCode: string;
  status: PkRoomStatus;
  /** 按入房顺序，`players[0]` 即房主——唯一有权 start 的人 */
  players: PkPlayer[];
  /** 各玩家 CD 解锁时刻（ms）；P0-1 恒空对象，P0-2 起填 */
  nextQuizAt: Record<string, number>;
  /** 对局截止时刻（ms）；仅 active 有效，其余为 0 */
  endsAt: number;
  /** 答题方视角的题目列表 */
  questions: PkQuestion[];
  /** finished 时的胜者 userId；平局则无此字段 */
  winner?: string;
}

// ── 域错误码（域层 throw，路由层映射 HTTP 状态）────────────

/**
 * PK 域错误码。**域层不碰 HTTP**——抛这个码，由薄路由映射状态码。
 * 分离理由：同一语义（如「房间满了」）在 REST 与将来可能的 WS 通道上要给不同错误码与文案，
 * 把状态码写进域层等于把传输格式焊死在业务逻辑里。
 */
export type PkRoomError =
  /** 房号查无此房（或已被 TTL 回收）→ 404 */
  | 'ROOM_NOT_FOUND'
  /** 房已满（P0 上限 2 人）→ 409 */
  | 'ROOM_FULL'
  /** 房已 active/finished，不能再入房或重复开局 → 409 */
  | 'ROOM_NOT_WAITING'
  /** 人数不足（对手还没进房）→ 409 */
  | 'ROOM_NOT_READY'
  /** 非房主无权 start → 403 */
  | 'NOT_ROOM_OWNER'
  /** 房号生成连续碰撞（理论不可达，兜底不静默）→ 500 */
  | 'ROOM_CODE_EXHAUSTED';

