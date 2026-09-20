/**
 * pk — AI 出题 PK 契约（docs/PK-SPEC.md，先登记再实现）。
 *
 * 批次节奏：P0-1 ＝ 登录 + 房间（建房 / 入房 / start）+ SSE `pk:` 频道；
 * P0-2 ＝ 计分（本文件现覆盖：CD/答题时限/怠慢三常量 + PVE 模式 + 对局错误码）——
 * 2026-09-12 老板拍板「P0-2 与 PVE AI 对战一体做」，三口子见 `PkMode` 注释。
 *
 * 单一事实源：常量 / 类型 / 频道键一律在此定义，server 与 web 只引用不复制。
 */

import type { QuizMix } from './content-blocks.js';

// ── 登录（P0-1）────────────────────────────────────────────

/**
 * 当前会话的 PK 身份（`GET /api/pk/auth/me` 响应主体）。
 *
 * ★ **B1（2026-09-20）起不再由客户端自报**：身份来自服务端 httpOnly cookie 会话
 *   （`AUTH-SPEC` 的统一账号体系），域名侧只读不写。此前 P0 的形态是「前端存 localStorage
 *   里的 userId、每个端点显式传 `{ userId }`」——单机 demo 无害，**一上公网就是「改一个参数
 *   就能冒充别人」**（`PK-SPEC §14.1` 的原话）。
 * ★ 原 `openid` 字段已删除：微信网页授权需企业主体，对个人**永久不可得**（`AUTH-SPEC §0.1`
 *   2026-09-18 拍板不做），这个字段从此没有任何取值来源。前端从未使用过它（已核）。
 */
export interface PkIdentity {
  /** 统一账号 `users.id`（`u-<uuid>`） */
  userId: string;
  /** 昵称（1~20 字，trim 后非空），在账号设置里改，PK 内不再有登录/改名表单 */
  nickname: string;
}

/**
 * `local` 部署形态（本地单人，`AUTH-SPEC §2.9`）的兜底 PK 身份。
 *
 * ★ 为什么需要它：本地形态「免登录可用」是**后端既有语义**（`ownerIdOf → null`＝不过滤/无主行），
 *   PK 不该比别的功能更严——否则本地想跑一局双人验证，得先折腾一遍邮箱注册收验证码。
 * ★ 线上（`cloud`）形态**绝不使用**：那时 `SB_REQUIRE_AUTH=1`，未登录请求在路由层就被
 *   `requireAuth` 401 挡下，根本走不到这个兜底。兜底只在「形态是 local」时可达。
 * ★ 固定 userId（而非随机）是刻意的：本地刷新页面后仍是同一个「本地玩家」，不至于每刷新一次
 *   就变成另一个人（房间里的席位会认不出他）。
 */
export const PK_LOCAL_IDENTITY: PkIdentity = { userId: 'local-user', nickname: '本地玩家' };

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

// ── 计分常量（P0-2，契约 §1；此前刻意未登记，随计分逻辑同批落地）────────

/** 出题冷却：同一玩家两次成功出题的最小间隔；CD 内提交 → 429 且不扣分 */
export const QUIZ_CD_MS = 60_000;
/** 答题时限：超时未答由服务端判罚 −1，之后该题作废（含 AI——人机同口径） */
export const ANSWER_TIME_MS = 45_000;
/** 怠慢惩罚窗口：对局进行中每这么久无一次成功出题 → −1，可累计 */
export const IDLE_PENALTY_MS = 120_000;
/** PVE 开局后 AI 的第一题延迟（秒开显得假，给一点「进入状态」的时间） */
export const AI_FIRST_QUIZ_DELAY_MS = 5_000;
/** AI 出题失败后的重试间隔（失败不计 CD、不扣分，契约 §3） */
export const AI_RETRY_DELAY_MS = 10_000;
/** 出题提示词上限（契约 §2.1，服务端截断前的硬校验） */
export const PK_PROMPT_MAX = 300;

/**
 * PK 出题固定「一道单选」——系统约束层直接用配比表达，不另写提示词分支。
 * ★ P0-7 下沉到 shared 的原因：裁判 AI（pk/judge.ts）出「二次机会的类似题」也要用同一配比，
 *   而 judge 被 match 依赖，若配比留在 match 里就会形成 judge ↔ match 循环依赖。
 *   配比只有一个事实源，人出题与裁判出题才不会有一天跑偏成两种题量。
 */
export const PK_QUIZ_MIX: QuizMix = { single: 1, multiple: 0, fill: 0, essay: 0, scenario: 0 };

// ── 主题轮转 / 道具 / 二次机会（P0-7，2026-09-13 老板点单）────────────

/** 主题字数上限：太长则判不出贴合度，也显示不下（服务端截断前硬校验） */
export const TOPIC_MAX = 20;
/** PVE 建房未指定方向时，AI 座位的兜底主题（AI 不会自己去填表单，不该拿这个卡住房主开局） */
export const PK_DEFAULT_AI_TOPIC = '通用知识';
/**
 * 裁判 AI 出题时的 `fromUserId`（二次机会的类似题由裁判出，不是任何一方出的）。
 * 固定值而非真账号——裁判不是玩家，不参与计分、不占座位，前端据此显示「裁判出题」。
 */
export const JUDGE_USER_ID = 'judge';
/**
 * 出题连续失败到几次扣 1 分。**累计满 3 次扣 1 分，扣完计数清零**——
 * 用累计而非「连续」是因为：中间成功一次就清零会让「反复试探边界」零成本。
 */
export const QUIZ_FAIL_STRIKE = 3;
/** 二次机会冷却：3 分钟（老板原话「有 3 分钟 cd」），防止刷错题补救分 */
export const RETRY_CD_MS = 3 * 60_000;
/** 每局每人的「求助 AI」道具数（用完即止，不随对局时间恢复） */
export const HELP_PER_MATCH = 1;
/** 二次机会的类似题答对得分：与答对对手题同档（+2），原错题的 −1 **不撤销**（老板拍板） */
export const RETRY_CORRECT_DELTA = 2;

// ── 对战模式（PVE，2026-09-12 老板拍板三口子：一体做计分+PVE／AI 与人同口径答题／人机对称出题）──

export type PkMode = 'pvp' | 'pve';

/** AI 座位 userId 前缀：PVE 房的第二个座位由 AI 占据，`ai-<roomId>` */
export const AI_USER_PREFIX = 'ai-';

export function isAiUserId(userId: string): boolean {
  return userId.startsWith(AI_USER_PREFIX);
}

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
  /** 本人选定的对战主题（≤ `TOPIC_MAX` 字）；未选为空串。PVE 的 AI 座位由建房主题填充 */
  topic: string;
  /** 剩余「求助 AI」道具数（`HELP_PER_MATCH` 起，用完为 0） */
  helpLeft: number;
  /**
   * 出题失败累计次数（主题不符 / AI 生成失败都算）。
   * 每满 `QUIZ_FAIL_STRIKE` 扣 1 分并清零；成功出题时**也清零**（成功即证明已回到正轨）。
   */
  failStreak: number;
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
  /** 答题方的最终选择（选项下标）。**判定后才回填下发**；pending 时无此字段 */
  chosen?: number;
  /**
   * 正确选项下标——**判定后（答对/答错/超时）才回填下发**。
   * 此前这个字段绝不出现在任何载荷（契约 §1「正确答案永不下发」的实现口径：
   * pending 阶段快照里连键都没有，不是「值为 null」——不给手滑留口子）。
   */
  answerRevealed?: number;
  /** P0-7：本题所属主题（即出这道题时的「当前轮次主题」） */
  topic?: string;
  /** P0-7：二次机会来源题 id——仅由「二次机会」生成的类似题带此字段 */
  retryOf?: string;
  /** P0-7：是否为二次机会的类似题（前端据此标注「补救题」，答对 +2） */
  isRetry?: boolean;
}

/**
 * UX 批（2026-09-15 老板点单）：**有人正在 AI 出题**。
 *
 * ★ 为什么必须有这个信号（不能纯前端猜）：出题要 `await generateQuiz` **数秒**，
 *   这段时间任何一方都无从推断对手是不是点了出题——**没有它，答题方只能看着题目凭空出现**
 *   （老板实测原话：「在玩家看来，对面出题就是突然题目出现了」）。
 *
 * ★ 为什么可以走 SSE（不违反决策⑫）：「谁在出题」是**公开事实**（跟比分一样双方都该看到），
 *   不是「私有判定结果」——决策⑫限制的是后者（判分、正确答案），不是前者。
 *
 * ★ 只带「谁在出」+「何时开始」，**绝不预带题目内容**：题目生成完才进 `questions`，
 *   提前下发等于把半成品（甚至是被裁判毙掉的跑题题）泄给答题方。
 */
export interface PkQuizPending {
  /** 正在出题的人（可能是 AI 座位 `ai-<roomId>`）；前端据此显示「对手／AI 正在出题」 */
  userId: string;
  /** 出题开始时刻（ms）：前端据此算「已经出了多久」，超时未出可自行收敛文案（别一直转圈） */
  at: number;
}

/** 对局快照（GET /api/pk/rooms/:id/state 响应 / SSE `pk-state` 载荷） */
export interface PkRoomState {
  roomId: string;
  /** 6 位房号：入房凭证（房号与 roomId 分离，房号可被人念出来） */
  roomCode: string;
  status: PkRoomStatus;
  /** pvp = 双人对战；pve = 人机对战（第二座位是 AI，见 `isAiUserId`） */
  mode: PkMode;
  /** PVE 建房时可选的「主题方向」；空 = AI 自选主题轮换 */
  aiTopic?: string;
  /** 按入房顺序，`players[0]` 即房主——唯一有权 start 的人 */
  players: PkPlayer[];
  /** 各玩家 CD 解锁时刻（ms）；P0-1 恒空对象，P0-2 起填 */
  nextQuizAt: Record<string, number>;
  /** 对局截止时刻（ms）；仅 active 有效，其余为 0 */
  endsAt: number;
  /** 答题方视角的题目列表 */
  questions: PkQuestion[];
  /** P0-7：当前轮次主题——**谁出题都必须贴合它**，每成功出一道题就切到另一方的主题 */
  currentTopic: string;
  /** P0-7：当前轮次主题归属的玩家 userId（决定下一次切给谁） */
  topicOwnerId: string;
  /** P0-7：已成功出题计数（轮次游标；偶数轮 = players[0] 的主题，奇数轮 = players[1] 的） */
  topicTurn: number;
  /** P0-7：各玩家二次机会解锁时刻（ms）；未用过则无此键 */
  retryNextAt: Record<string, number>;
  /** finished 时的胜者 userId；平局则无此字段 */
  winner?: string;
  /**
   * P0-8：结束原因（仅 finished 有）。`timeup` 缺省不写——老字段语义不变（时钟归零），
   * 只有 `forfeit` 这种「非时间到」的结束才需要显式标注，前端据此换文案。
   */
  endReason?: PkEndReason;
  /**
   * UX 批（2026-09-15 老板点单）：**正在 AI 出题的人**（无人出题则无此字段）。
   * 见下方 `PkQuizPending`——出题要 `await` 数秒，这段时间不给信号，答题方只能看着题目凭空出现。
   */
  quizPending?: PkQuizPending;
}

/**
 * P0-7：裁判 AI 的一次输出（失败建议 / 道具求助共用形状）。
 * ★ `advice` 与 `knowledge` 分开给——前者是「怎么出」的选型建议，后者是「相关知识」补全，
 *   混成一段会让玩家读完不知道下一步该干嘛。
 */
export interface PkJudgeAdvice {
  /** 贴合主题的出题选型建议（3 条以内，每条可直接抄去当提示词） */
  advice: string[];
  /** 该主题的相关知识要点（联网检索后整理；无检索结果时退回模型知识） */
  knowledge: string;
  /** 参考来源（联网命中才有）；前端渲染成链接清单，与题库来源同一套口径 */
  refs: { n: number; title: string; url: string; provider: string }[];
}

// ── P0-8：投降 + 对战历史（2026-09-14 老板点单，契约 §12）──────────

/**
 * 对局结束原因。`timeup` = 8 分钟时钟归零结算；`forfeit` = 一方认输。
 * ★ 前端必须据此把结果说成「对方认输」/「你已认输」——只写「对局结束」，
 *   投降的人不确定自己那一步到底生效没有（原地怀疑按钮坏了）。
 */
export type PkEndReason = 'timeup' | 'forfeit';

/** 我的视角胜负。平局只可能来自 `timeup`——投降必分胜负。 */
export type PkOutcome = 'win' | 'lose' | 'draw';

/** 历史列表默认返回条数（客户端不传 limit 时） */
export const PK_HISTORY_LIMIT = 20;
/** 历史列表单次上限：传超大 limit 也钳到这里（防一次把库拉空，那是「打不开页面」而不是「看得多」） */
export const PK_HISTORY_MAX = 100;
/**
 * 每人保留的历史条数：超出即删最旧（房间有 TTL 防内存无界增长，历史同理——快照一局几 KB）。
 * ★ 与 `PK_HISTORY_MAX` **刻意同档 100**：还没有分页，比单页上限更旧的记录根本拉不出来，
 *   留更多只是占盘（本仓不做「提前造用不到的东西」）。
 * ★ 硬约束：**保留量必须 ≥ 单页上限**，否则列表永远填不满。要抬就两个一起抬。
 */
export const PK_HISTORY_KEEP = 100;

/**
 * 历史列表一行（**我的视角**：对手是谁、我赢还是输都已经折算好）。
 * 存的是视角行而不是「一局一行 + 两个玩家字段」——见 `pk/history.ts` 文件头的取舍说明。
 */
export interface PkMatchRecord {
  id: string;
  roomId: string;
  mode: PkMode;
  opponentId: string;
  /** 对手昵称**快照**：对手后来改了名，历史里仍应显示当时对战的名字 */
  opponentNickname: string;
  myScore: number;
  oppScore: number;
  outcome: PkOutcome;
  reason: PkEndReason;
  /** 该局生成过的题目总数（含结束时仍未作答的） */
  quizCount: number;
  endedAt: number;
}

/** 历史详情 ＝ 列表行 + 该局末快照（题目回看：题干/选项/我选了什么/正确答案都在里面） */
export interface PkMatchDetail extends PkMatchRecord {
  snapshot: PkRoomState;
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
  /** 对局未进行中（waiting/finished 时出题或答题）→ 409 */
  | 'ROOM_NOT_ACTIVE'
  /** 操作者不在房内 → 403 */
  | 'NOT_A_PLAYER'
  /** 出题 CD 内（`now < nextQuizAt`）→ 429，不扣分 */
  | 'QUIZ_ON_COOLDOWN'
  /** 出题提示词非法（空 / 超 `PK_PROMPT_MAX`）→ 400 */
  | 'PROMPT_INVALID'
  /** 题不存在（id 错或已被清理）→ 404 */
  | 'QUESTION_NOT_FOUND'
  /** 该题不是发给你的 → 403 */
  | 'QUESTION_NOT_YOURS'
  /** 该题已被答 / 已判超时 → 409 */
  | 'QUESTION_DONE'
  /** 答案选项下标非法 → 400 */
  | 'CHOICE_INVALID'
  /** AI 出题失败（模型不可用 / 输出不合法）→ 502，不计 CD 不扣分 */
  | 'AI_GENERATION_FAILED'
  /** 房号生成连续碰撞（理论不可达，兜底不静默）→ 500 */
  | 'ROOM_CODE_EXHAUSTED'
  // ── P0-7：主题轮转 / 道具 / 二次机会 ──
  /** 主题非法（空 / 超 `TOPIC_MAX`）→ 400 */
  | 'TOPIC_INVALID'
  /** 还没选定主题就想开局或出题 → 409 */
  | 'TOPIC_NOT_SET'
  /** 出的题不贴合当前轮次主题 → 422，不占 CD 可重试，失败计数 +1 */
  | 'TOPIC_MISMATCH'
  /** 道具已用完（每局 `HELP_PER_MATCH` 个）→ 409 */
  | 'HELP_EXHAUSTED'
  /** 二次机会冷却中（距上次 `RETRY_CD_MS`）→ 429 */
  | 'RETRY_ON_COOLDOWN'
  /** 没有可用于二次机会的错题（没有答错过的题）→ 404 */
  | 'RETRY_NO_TARGET'
  /** 那道错题不是你答的 → 403 */
  | 'RETRY_NOT_YOURS'
  /** 裁判 AI 不可用（judge 角色没绑模型 / 调用失败）→ 502，不阻断对局 */
  | 'JUDGE_UNAVAILABLE'
  // ── P0-8：投降 / 对战历史 ──
  /**
   * 历史那条记录不存在**或不属于你** → 404。
   * ★ 两种情况**故意合成一个码**：分开（403「不是你的」/404「不存在」）等于把
   *   「这个 id 存在」告诉了一个没权限的人——别人的对局是否存在，不关你的事。
   */
  | 'MATCH_NOT_FOUND';

