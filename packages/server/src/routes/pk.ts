/**
 * routes/pk — AI 出题 PK 薄路由（契约 docs/PK-SPEC.md，先契约后实现）。
 *
 * 覆盖：登录两端点 + 房间四端点 + 计分两端点（P0-2）+ SSE 频道；PVE 建房参数（mode/aiTopic）。
 * 路由只做三件事：参数校验、调域层、把域层错误码映射成 HTTP——业务规则一律不在这一层。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { pkChannel, type PkIdentity, type PkMode, type PkRoomError, type PkRoomState } from '@sb/shared';
import { getIdentity, loginOrRegister } from '../pk/auth.js';
import { createRoom, getRoomState, joinRoom, startRoom } from '../pk/room.js';
import { ensureTicker, submitAnswer, submitQuiz } from '../pk/match.js';
import { publish, subscribe } from '../chat/sse-bus.js';

export const pkRouter = Router();

/** 域错误码 → HTTP 状态（映射只此一处；域层不碰 HTTP） */
const ERROR_STATUS: Record<PkRoomError, number> = {
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  ROOM_NOT_WAITING: 409,
  ROOM_NOT_READY: 409,
  NOT_ROOM_OWNER: 403,
  ROOM_NOT_ACTIVE: 409,
  NOT_A_PLAYER: 403,
  QUIZ_ON_COOLDOWN: 429,
  PROMPT_INVALID: 400,
  QUESTION_NOT_FOUND: 404,
  QUESTION_NOT_YOURS: 403,
  QUESTION_DONE: 409,
  CHOICE_INVALID: 400,
  AI_GENERATION_FAILED: 502,
  ROOM_CODE_EXHAUSTED: 500,
};

/** 域错误码 → 人话文案（ADR-5：失败必须可读、可重试，不裸抛码） */
const ERROR_TEXT: Record<PkRoomError, string> = {
  ROOM_NOT_FOUND: '房间不存在或已失效，请确认房号',
  ROOM_FULL: '房间已满（双人对战只坐两人）',
  ROOM_NOT_WAITING: '这局已经开始或结束了，不能加入',
  ROOM_NOT_READY: '还要等对手进房才能开始',
  NOT_ROOM_OWNER: '只有房主能开始对局',
  ROOM_NOT_ACTIVE: '对局不在进行中',
  NOT_A_PLAYER: '你不在这间房里',
  QUIZ_ON_COOLDOWN: '出题冷却中，稍等几秒再出',
  PROMPT_INVALID: '出题提示词不能为空',
  QUESTION_NOT_FOUND: '题目不存在',
  QUESTION_NOT_YOURS: '这道题不是发给你答的',
  QUESTION_DONE: '这道题已经被答过或已超时',
  CHOICE_INVALID: '选项不合法',
  AI_GENERATION_FAILED: 'AI 出题失败，可免费重试（不计冷却不扣分）',
  ROOM_CODE_EXHAUSTED: '房号分配失败，请重试',
};

/** 域层错误 → HTTP 响应；非域错误一律 500（不把内部异常当业务错误外泄） */
function fail(res: Response, e: unknown): void {
  const code = e instanceof Error ? (e.message as PkRoomError) : undefined;
  if (code === undefined || !(code in ERROR_STATUS)) {
    res.status(500).json({ error: '服务器内部错误' });
    return;
  }
  res.status(ERROR_STATUS[code]).json({ error: ERROR_TEXT[code], code });
}

/**
 * 身份闸门：userId 必须命中**服务端已存在的账号**。
 * ★ 昵称一律从库里取、不信客户端自报——房内显示名若能用请求体伪造，就等于给冒名留了口子。
 */
function requireIdentity(rawUserId: unknown, res: Response): PkIdentity | null {
  const identity = getIdentity(rawUserId);
  if (!identity) {
    res.status(401).json({ error: '请先登录（userId 无效或账号已不存在）' });
    return null;
  }
  return identity;
}

/** 状态变更后主动广播到房间频道（契约 §2.2：服务端推，客户端不靠轮询发现状态变化） */
function broadcast(state: PkRoomState): void {
  publish(pkChannel(state.roomId), { type: 'pk-state', roomId: state.roomId, state });
}

// ── 登录（P0 模拟实现，契约 §2.1）────────────────────────────

/**
 * 登录：{ nickname, userId? } → PkIdentity。
 * 携带已存在的 userId = 找回账号（可顺带改名）；否则新建。
 * P1 替换为微信公众号网页授权（oauth2 code → openid）时：入参换成 code、
 * openid 换真值，**响应结构不变**——前端零改动（契约先行的意义所在）。
 */
pkRouter.post('/auth/login', (req: Request, res: Response) => {
  const { nickname, userId } = req.body as { nickname?: unknown; userId?: unknown };
  if (userId !== undefined && (typeof userId !== 'string' || !userId)) {
    res.status(400).json({ error: 'userId 必须是非空字符串' });
    return;
  }
  try {
    res.json(loginOrRegister(nickname as string, userId));
  } catch {
    // 域层只抛 NICKNAME_INVALID 一种错（唯一已知失败因），薄路由按语义转 400
    res.status(400).json({ error: 'nickname 必填（1~20 字）' });
  }
});

/** 本地登录态校验：userId 命中 → PkIdentity；不存在 → 404（前端据此清 localStorage）。 */
pkRouter.get('/auth/me', (req: Request, res: Response) => {
  const identity = getIdentity(req.query.userId);
  if (!identity) {
    res.status(404).json({ error: '账号不存在' });
    return;
  }
  res.json(identity);
});

// ── 房间（P0-1，契约 §2.1）──────────────────────────────────

/** 建房：{ userId, mode?, aiTopic? } → { roomId, roomCode, state }。已在某 waiting 房则**返回原房**（幂等）。 */
pkRouter.post('/rooms', (req: Request, res: Response) => {
  const identity = requireIdentity(req.body?.userId, res);
  if (!identity) return;
  const mode: PkMode = req.body?.mode === 'pve' ? 'pve' : 'pvp';
  const aiTopic = typeof req.body?.aiTopic === 'string' ? req.body.aiTopic : undefined;
  try {
    const state = createRoom(identity, mode, aiTopic);
    broadcast(state);
    res.status(201).json({ roomId: state.roomId, roomCode: state.roomCode, state });
  } catch (e) {
    fail(res, e);
  }
});

/** 按房号入房：{ roomCode, userId } → { roomId, state }。房不存在 404／满员 409。 */
pkRouter.post('/rooms/join', (req: Request, res: Response) => {
  const { roomCode, userId } = req.body as { roomCode?: unknown; userId?: unknown };
  const identity = requireIdentity(userId, res);
  if (!identity) return;
  if (typeof roomCode !== 'string' || !roomCode.trim()) {
    res.status(400).json({ error: 'roomCode 必填' });
    return;
  }
  try {
    const state = joinRoom(roomCode, identity);
    broadcast(state);
    res.json({ roomId: state.roomId, state });
  } catch (e) {
    fail(res, e);
  }
});

/** 开局（仅房主、双方已进房）：{ userId } → { state }；置 active 并给出 endsAt。PVE 房 AI 座位已占，房主可直接开。 */
pkRouter.post('/rooms/:id/start', (req: Request, res: Response) => {
  const identity = requireIdentity(req.body?.userId, res);
  if (!identity) return;
  try {
    const state = startRoom(req.params.id, identity);
    broadcast(state);
    ensureTicker(); // 1s ticker：结算/超时/怠慢/AI 出题统一时间驱动（无 active 房时自停）
    res.json({ state });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * 出题：{ userId, prompt } → { state }。AI 生成耗时数秒为正常（同步返回最终快照）；
 * CD 内 429 不扣分；AI 失败 502 已回滚 CD（免费重试）。
 */
pkRouter.post('/rooms/:id/quiz', (req: Request, res: Response) => {
  const identity = requireIdentity(req.body?.userId, res);
  if (!identity) return;
  void (async () => {
    try {
      const state = await submitQuiz(String(req.params.id ?? ''), identity.userId, req.body?.prompt);
      res.json({ state });
    } catch (e) {
      fail(res, e);
    }
  })();
});

/** 答题：{ userId, questionId, choice } → { correct, delta, score }（契约 §2.1）。 */
pkRouter.post('/rooms/:id/answer', (req: Request, res: Response) => {
  const identity = requireIdentity(req.body?.userId, res);
  if (!identity) return;
  try {
    const choice = typeof req.body?.choice === 'number' ? req.body.choice : Number(req.body?.choice);
    const r = submitAnswer(String(req.params.id ?? ''), identity.userId, req.body?.questionId, choice);
    res.json(r);
  } catch (e) {
    fail(res, e);
  }
});

/** 房间快照（断线重连对齐用）：不存在/已回收 → 404。 */
pkRouter.get('/rooms/:id/state', (req: Request, res: Response) => {
  const state = getRoomState(req.params.id);
  if (!state) {
    res.status(404).json({ error: '房间不存在或已失效' });
    return;
  }
  res.json({ state });
});

/**
 * SSE 房间频道（`pk:<roomId>`，契约 §2.2）。
 * ★ 与聊天 `/api/chat/stream` **共用 sse-bus 实现，但频道键前缀隔离**——房间号绝不与 sessionId
 *   共用一个命名空间（v1 串台教训）。P0-1 按房间整广播：载荷结构里本就没有 answer，
 *   不存在按人裁剪的需要（P0-2 出题后仍是整广播——正确答案只活在服务端内部）。
 * ★ 订阅前先验房间在不在：已被 TTL 回收时立刻 404，好过让前端挂一条永远安静的长连接。
 */
pkRouter.get('/stream', (req: Request, res: Response) => {
  const roomId = String(req.query.roomId ?? '');
  if (!roomId) {
    res.status(400).json({ error: 'roomId 必填' });
    return;
  }
  if (!getRoomState(roomId)) {
    res.status(404).json({ error: '房间不存在或已失效' });
    return;
  }
  const since = Number(req.query.since ?? 0) || 0;
  subscribe(pkChannel(roomId), res, since);
});
