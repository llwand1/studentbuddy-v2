/**
 * routes/pk — AI 出题 PK 薄路由（契约 docs/PK-SPEC.md，先契约后实现）。
 *
 * 覆盖：登录两端点 + 房间四端点 + 计分两端点（P0-2）+ SSE 频道；PVE 建房参数（mode/aiTopic）。
 * 路由只做三件事：参数校验、调域层、把域层错误码映射成 HTTP——业务规则一律不在这一层。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { pkChannel, type PkMode, type PkRoomError, type PkRoomState } from '@sb/shared';
import { pkIdentityOf } from '../pk/auth.js';
import { createRoom, getRoomState, joinRoom, setTopic, startRoom } from '../pk/room.js';
import { ensureTicker, submitAnswer, submitQuiz } from '../pk/match.js';
import { requestRetry, useHelp } from '../pk/power.js';
import { forfeitRoom } from '../pk/settle.js';
import { getMatchDetail, listMatches } from '../pk/history.js';
import { publish, subscribe } from '../chat/sse-bus.js';
import { ownerIdOf } from '../auth/ownership.js';

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
  TOPIC_INVALID: 400,
  TOPIC_NOT_SET: 409,
  TOPIC_MISMATCH: 422,
  HELP_EXHAUSTED: 409,
  RETRY_ON_COOLDOWN: 429,
  RETRY_NO_TARGET: 404,
  RETRY_NOT_YOURS: 403,
  JUDGE_UNAVAILABLE: 502,
  MATCH_NOT_FOUND: 404,
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
  TOPIC_INVALID: '主题不能为空（上限 20 字）',
  TOPIC_NOT_SET: '还有人没选定主题，选好才能开局',
  TOPIC_MISMATCH: '这道题跑题了，不符合当前轮次主题',
  HELP_EXHAUSTED: '求助道具已经用掉了（每局只有 1 个）',
  RETRY_ON_COOLDOWN: '二次机会冷却中（3 分钟一次）',
  RETRY_NO_TARGET: '还没有答错的题，暂时用不了二次机会',
  RETRY_NOT_YOURS: '那道错题不是你答的',
  JUDGE_UNAVAILABLE: '裁判 AI 这会儿不可用（去设置页给「裁判」角色绑个模型）',
  MATCH_NOT_FOUND: '这条对战记录不存在',
};

/** 域层错误 → HTTP 响应；非域错误一律 500（不把内部异常当业务错误外泄） */
function fail(res: Response, e: unknown): void {
  const code = e instanceof Error ? (e.message as PkRoomError) : undefined;
  if (code === undefined || !(code in ERROR_STATUS)) {
    res.status(500).json({ error: '服务器内部错误' });
    return;
  }
  // extra：域层随错误回传的附加数据（典型是跑题时裁判给的建议）。
  // ★ 只有域层显式带了才回——普通错误多带一个空字段，只会让前端契约变模糊。
  const extra = (e as { extra?: unknown }).extra;
  res.status(ERROR_STATUS[code]).json({ error: ERROR_TEXT[code], code, ...(extra ? { extra } : {}) });
}

/**
 * 构造一个「与域层抛出等价」的 Error：路由**自己**判定的失败（典型：历史记录查不到）
 * 也走 `fail()` 那条唯一映射，免得在这里手写一遍响应体形状。
 */
function domainError(code: PkRoomError): Error {
  return new Error(code);
}

/**
 * 未登录响应（B1 §14.1）。
 *
 * ★ 改造前这里是 `requireIdentity(rawUserId)`：**从请求体里取 userId 再查库**——
 *   等于让客户端自己声明「我是谁」，改个参数就能冒充别人。现在身份只来自 cookie 会话
 *   （`pkIdentityOf`），**路径上不再有任何 `{ userId }` 入参**。
 * ★ `code` 与 `requireAuth` 中间件保持同一个值：前端处理 401 只需认这一个（不必分辨
 *   是全局闸门拦的还是路由自己拦的——对用户而言是同一件事：去登录）。
 */
function unauthorized(res: Response): void {
  res.status(401).json({ error: '请先登录（PK 需要账号身份）', code: 'UNAUTHENTICATED' });
}

/** 状态变更后主动广播到房间频道（契约 §2.2：服务端推，客户端不靠轮询发现状态变化） */
function broadcast(state: PkRoomState): void {
  publish(pkChannel(state.roomId), { type: 'pk-state', roomId: state.roomId, state });
}

// ── 身份（B1 §14.1：并入统一账号，PK 侧不再有登录端点）────────────

/**
 * ★ `POST /auth/login` **已删除**（§14.4「`pk/auth.ts` 整体废弃」）。
 *   登录/注册一律走统一账号端点（`/api/auth/*`：密码 / 邮箱验证码 / GitHub 三通道），
 *   产出同一种 cookie 会话（`AUTH-SPEC §2.8` 末句：三条通道**产出同一种会话**）。
 *   PK 侧不需要、也不该有第二套登录。老前端若仍打这个端点会拿到 **404**——
 *   清晰可查，不是静默降级。
 */

/**
 * 当前 PK 身份（前端启动时问一次）：有会话 → `PkIdentity`；未登录 → 401。
 *
 * ★ 与改造前的三处不同：① **不再收 `?userId=`**（那是自证，§14.1 要拆掉的东西）；
 *   ② 未登录从 404 改 **401**——语义本就该是「没登录」，404 是当年为「清 localStorage」
 *   硬凑的判据，而 localStorage 那套身份已经不存在了；③ local 形态下回兜底身份。
 */
pkRouter.get('/auth/me', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) {
    unauthorized(res);
    return;
  }
  res.json(identity);
});

// ── 房间（P0-1，契约 §2.1）──────────────────────────────────

/** 建房：{ userId, mode?, aiTopic? } → { roomId, roomCode, state }。已在某 waiting 房则**返回原房**（幂等）。 */
pkRouter.post('/rooms', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  const mode: PkMode = req.body?.mode === 'pve' ? 'pve' : 'pvp';
  const aiTopic = typeof req.body?.aiTopic === 'string' ? req.body.aiTopic : undefined;
  const topic = typeof req.body?.topic === 'string' ? req.body.topic : undefined;
  try {
    const state = createRoom(identity, mode, aiTopic, topic);
    broadcast(state);
    res.status(201).json({ roomId: state.roomId, roomCode: state.roomCode, state });
  } catch (e) {
    fail(res, e);
  }
});

/** 按房号入房：{ roomCode, userId } → { roomId, state }。房不存在 404／满员 409。 */
pkRouter.post('/rooms/join', (req: Request, res: Response) => {
  const { roomCode } = req.body as { roomCode?: unknown };
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
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
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
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
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  void (async () => {
    try {
      // ★ M2c：末参是**账号归属**（谁付模型钱），与 `identity.userId`（对局身份，允许游客/AI）
      //   是两回事——见 pk/match.ts 的 submitQuiz 注释。未登录 ⇒ null = 平台通道。
      const state = await submitQuiz(
        String(req.params.id ?? ''),
        identity.userId,
        req.body?.prompt,
        undefined,
        ownerIdOf(req),
      );
      res.json({ state });
    } catch (e) {
      fail(res, e);
    }
  })();
});

/** 答题：{ userId, questionId, choice } → { correct, delta, score }（契约 §2.1）。 */
pkRouter.post('/rooms/:id/answer', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  try {
    const choice = typeof req.body?.choice === 'number' ? req.body.choice : Number(req.body?.choice);
    const r = submitAnswer(String(req.params.id ?? ''), identity.userId, req.body?.questionId, choice);
    res.json(r);
  } catch (e) {
    fail(res, e);
  }
});

/**
 * P0-7：选定本人对战主题（仅 waiting 期可改，开局后改主题＝中途改规则）：
 * `{ userId, topic }` → `{ state }`。主题不参与胜负，只决定「轮到这一轮该出什么题」。
 */
pkRouter.post('/rooms/:id/topic', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  try {
    const state = setTopic(String(req.params.id ?? ''), identity, req.body?.topic);
    broadcast(state);
    res.json({ state });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * P0-7：求助道具（每局每人 1 个，用完即止）：`{ userId, questionId }` → `{ advice, state }`。
 * 裁判**当场联网搜索**后给建议与知识输出；**不给答案**（那条硬规矩写在 judge 的提示词里）。
 */
pkRouter.post('/rooms/:id/help', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  void (async () => {
    try {
      const r = await useHelp(
        String(req.params.id ?? ''),
        identity.userId,
        req.body?.questionId,
        undefined,
        ownerIdOf(req),
      );
      res.json(r);
    } catch (e) {
      fail(res, e);
    }
  })();
});

/**
 * P0-7：错题二次机会（3 分钟 CD）：`{ userId, questionId }` → `{ explanation, question, state }`。
 * 选一道自己答错（或超时）的题 → 裁判给现场解析 + 按同一主题出一道类似题；
 * 类似题答对 +2（走既有 `/answer`，原错题的 −1 不撤销）。出题失败时 `question` 为 null 但解析照给。
 */
pkRouter.post('/rooms/:id/retry', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  void (async () => {
    try {
      const r = await requestRetry(
        String(req.params.id ?? ''),
        identity.userId,
        req.body?.questionId,
        undefined,
        ownerIdOf(req),
      );
      res.json(r);
    } catch (e) {
      fail(res, e);
    }
  })();
});

/**
 * P0-8：认输（契约 §12.1）：`{ userId }` → `{ state }`。对手直接胜、**比分定格**（不额外扣分）。
 * ★ 服务端**不加二次确认门**：该端点是幂等的状态转换，重复调用只会撞 409 `ROOM_NOT_ACTIVE`。
 *   防误触是前端的活（`PkForfeit` 两段点选）——把「确认」做成服务端规则，代价是用户
 *   以为功能不存在（本仓已吃过这个亏）。
 */
pkRouter.post('/rooms/:id/forfeit', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  try {
    const state = forfeitRoom(String(req.params.id ?? ''), identity);
    broadcast(state);
    res.json({ state });
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

// ── 对战历史（P0-8，契约 §12.2）──────────────────────────────

/**
 * 我的对战历史（最近的在前）：`?userId=&limit=` → `{ matches }`。
 * limit 由 `clampHistoryLimit` 归一（缺省 20 / 上限 100）——客户端传超大值不该把库拉空。
 */
pkRouter.get('/matches', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  res.json({ matches: listMatches(identity.userId, req.query.limit) });
});

/**
 * 历史详情（含该局末快照，供题目回看）：`?userId=` → `{ match }`。
 * ★ 「查不到」与「不是你的」都是 404：不向无权限的人泄露「这个 id 存在」。
 * ★ 快照 JSON 解析失败会抛非域错误 → `fail()` 映射成 500。**不返回一份空局兜底**：
 *   坏数据装成正常的一局，比报错更难查。
 */
pkRouter.get('/matches/:id', (req: Request, res: Response) => {
  const identity = pkIdentityOf(req);
  if (!identity) return unauthorized(res);
  try {
    const match = getMatchDetail(req.params.id, identity.userId);
    if (!match) {
      fail(res, domainError('MATCH_NOT_FOUND'));
      return;
    }
    res.json({ match });
  } catch (e) {
    fail(res, e);
  }
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
