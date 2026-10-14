/** pk-history: split domain module; compatible exports remain at pk.ts. */
import type { PkMode } from './pk.js';
import type { PkRoomState } from './pk.js';

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

// ── P0-8：投降 + 对战历史（契约 §12）──────────

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
  | 'MATCH_NOT_FOUND'
  // ── §15 B3：词条出题（「不存在」与「不是你的」同 MATCH_NOT_FOUND 取向：合成一个码）──
  /** 词条 id 不存在或不属于你 → 404（别人的词条是否存在，不关你的事） */
  | 'TERM_NOT_FOUND'
  /** 一次带超过 `PK_TERM_MAX` 条词条 → 400 */
  | 'TERM_LIMIT_EXCEEDED'
  // ── §15 B4：情景题进对战 ──
  /** 回传的评分点 id 不在该题白名单内（不在 tasks 里＝不存在，不泄露别的） → 400 */
  | 'SCENARIO_TASK_INVALID';

/**
 * §16 邀请错误码（AI 主动发起对战）。
 *
 * ★ 为什么不并进 `PkRoomError`（契约 §16.5 原写「进 PkRoomError」，这里就地改正）：
 *   `routes/pk.ts` 里有两份 `Record<PkRoomError, …>`（状态码 + 人话文案）是**穷尽映射**，
 *   那个文件此刻 388/400 行——每往联合里加一码就要写满两行，加三码就把它顶到门禁红线。
 *   拆成独立联合后编译期仍然强制「每个错误码都有 HTTP 状态与文案」（换到新路由文件里写一份
 *   `Record<PkInviteError, …>`），**保证没丢，只是不再挤在同一张表里**。
 */
export type PkInviteError =
  /**
   * 邀请不存在**或不属于这个会话/这个主** → 404。
   * ★ 与 `MATCH_NOT_FOUND` 同取向：合成一个码，分开写等于告诉别人「这条 id 确实存在」。
   */
  | 'INVITE_NOT_FOUND'
  /** 这张卡已是终态（已接受/已拒绝），不再接受第二次决定 → 409。★ 幂等 accept 例外：重复点「接受」返回第一次那间房 */
  | 'INVITE_NOT_PENDING'
  /**
   * 频率闸门挡下（本会话有未答复的卡 / 距上一张太近 / 这人 24 小时内已发满）。
   * ★ **只回灌给模型，不映射成用户可见错误**——用户没点任何按钮时弹一条报错，
   *   只会让他以为产品坏了（契约 §16.7）。
   */
  | 'INVITE_THROTTLED'
  /** 工具入参不合法（话题/说明为空、无 sessionId）→ 400 语义。★ 只回灌给模型自纠，用户界面永远看不到它 */
  | 'INVITE_INPUT_INVALID'
  /**
   * 卡已 accepted，但它指的那间**内存房**没了（TTL 回收或发版重启）→ 404。
   * ★ 刻意不与 `INVITE_NOT_FOUND` 合码：这里的真相是「邀请在、局没了」，
   *   文案必须说「这场对战已结束或已失效」——说「邀请不存在」会让人以为按钮是坏的（§16.12 风险 5）。
   */
  | 'INVITE_ROOM_GONE';
