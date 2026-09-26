/**
 * SSE 事件契约（演进②③的承载）。
 *
 * 「先登记再实现」：任何新增事件类型必须先在此登记并同步 docs/SSE-CONTRACT.md，
 * 才允许在 server 广播 / web 消费。按 sessionId 隔离广播 + seq 单调去重。
 * ★ 事实边界：每个事件「携带哪些事实 / 前端禁止推断什么」的唯一事实源 = docs/SSE-CONTRACT.md §2.3
 *   （B-007/009/010「前端猜服务端事实」同族教训固化）；新增事件先过 §2.3.2 过闸七问再实现。
 */
import type { TaskItem } from './task-list.js';
import type { PkInviteRecord, PkInviteStatus, PkQuestion, PkRoomState } from './pk.js';
import type { AskChoiceRecord, AskChoiceReply } from './choice.js';
import type { CoachTrendCard } from './coach.js';
import type { ToolConfirmDecision } from './tool-ecosystem.js';


/** 服务端按会话推送的事件（seq 单调递增，新一轮对话从 1 重新计数） */
export type SseEvent =
  | { type: 'token'; seq: number; sessionId: string; content: string }
  | { type: 'reasoning'; seq: number; sessionId: string; content: string }
  | {
      type: 'block';
      seq: number;
      sessionId: string;
      blockId: string;
      /** 块已更新则替换同 blockId 内容（流式追加语义由 done 标记收口） */
      done: boolean;
      payload: unknown;
    }
  | {
      type: 'step';
      seq: number;
      sessionId: string;
      tool: string;
      status: 'running' | 'done' | 'error';
      detail?: string;
      /** 工具入参原文（JSON 串）：过程卡片点击展开时展示（2026-09-09 登记） */
      args?: string;
      /** 工具结果摘要（截断至 ~400 字）：同上，展开时展示，不回灌模型 */
      result?: string;
      // ── v1.3 扩展（2026-09-18 登记，P1 计时线落地；契约 TOOL-ECOSYSTEM-SPEC §4.7）──
      /** 模型侧工具调用 id（对齐 AG-UI toolCallId）：同名并行调用时替代「name+running 倒扫」的精确配对键 */
      toolCallId?: string;
      /**
       * 服务端实测执行耗时（ms），仅终态帧携带，随消息落库后历史回放同值。
       * 为何不自估/不前端掐表：AG-UI spec 明言事件 timestamp "MUST NOT" 参与计算且全协议无 duration；
       * LobeChat 前端计时在断线重连后丢起点——口径与依据逐条见契约 §4.7。
       */
      durationMs?: number;
      /** error 终态的人读错误（对齐 AI SDK output-error.errorText）：与 result 互斥，不伪装成结果摘要 */
      errorText?: string;
      /** 长耗时工具的中间输出（对齐 AI SDK preliminary）：收口前可多次 done+preliminary。P4 启用，先行登记 */
      preliminary?: boolean;
      /** 工具来源（契约 §6.4，v1.4/P3 登记）：P3 起恒 'builtin'，S3 接 MCP 后外部工具必带；老前端忽略即兼容 */
      source?: 'builtin' | 'mcp';
    }
  | {
      /**
       * 任务清单（标准 CoT）：模型经 update_tasks 工具维护；前端渲染为打勾清单。
       * items 恒为「当前完整清单」——模型可以只发改动条目（工具的 patch 模式），
       * 但服务端会把合并结果整表下发，前端据此整表替换，不做本地合并。
       */
      type: 'tasks';
      seq: number;
      sessionId: string;
      items: TaskItem[];
    }
  | { type: 'chat-error'; seq: number; sessionId: string; message: string }
  | {
      type: 'done';
      seq: number;
      sessionId: string;
      usage?: TokenUsage;
      /**
       * 服务端实测的本轮思考耗时（ms）：起点＝首个 reasoning 分片发出，终点＝首个正文分片（无正文则收口时刻）。
       * 未出过思考分片则不带（区别于 0）。落库先于本帧发布 ⇒ 线上值与 `messages.thinking_ms` 同源，
       * 前端不本地掐表（口径与证据见 TOOL-ECOSYSTEM-SPEC §4.7、SSE-CONTRACT §2）。
       */
      thinkingMs?: number;
    }
  // ── 轮起点（P0.5 热修批，2026-09-19 登记，契约 docs/SSE-CONTRACT.md §2）─────────
  // ★ 「思考中」计时的**唯一基准事实源**：前端组件挂载时刻 ≠ 轮开始时刻，
  //   切走会话再回来（组件重挂）若各自本地起表，已用时会被重置（bug-ledger B-009）。
  //   本帧恒为该轮缓冲的**第一帧** ⇒ 重订阅回放必带着它，基准随流自动恢复。
  // ★ 服务端 `Date.now()`、仅本机服务（127.0.0.1）——同机时钟无跨端偏差，前端直接相减。
  | { type: 'round-start'; seq: number; sessionId: string; startedAt: number }
  // ── PK 频道（AI 出题微信双人对战，契约 docs/PK-SPEC.md §2.2）─────────────
  // ★ 频道键为 `pk:<roomId>`（`shared/pk.ts` 的 `pkChannel()`）——与上面的 `sessionId` 空间
  //   严格隔离；两者共用 sse-bus 实现，靠频道键前缀防串台（v1 教训）。故本组事件用 `roomId`
  //   字段而非 `sessionId`：字段名不同，才不会有人把房间号当会话 ID 传进聊天通道。
  // ★ 载荷里**没有 answer**：正确答案永不下发（含 SSE），判分权只在服务端（契约 §1）。
  // P0-1 只发 `pk-state`；后三个按契约先登记、待 P0-2（出题与判分）实现时启用
  // ——「先登记再实现」是本仓纪律，契约已定的类型不必等实现才登记。
  | { type: 'pk-state'; seq: number; roomId: string; state: PkRoomState }
  | { type: 'pk-question'; seq: number; roomId: string; question: PkQuestion }
  | {
      type: 'pk-verdict';
      seq: number;
      roomId: string;
      questionId: string;
      /** 被判分的是谁（答题方）——PVE 后 AI 也走同一条判分路径，前端要分清是谁的分数在动 */
      byUserId: string;
      correct: boolean;
      /** 本题分数变化（答错 / 超时各 −1） */
      delta: number;
      /** 判分后的总分 */
      score: number;
    }
  | { type: 'pk-end'; seq: number; roomId: string; winner?: string; state: PkRoomState }
  // ── 方案选择框（AI 主动提问 → 用户点选 → 同轮继续，契约 docs/ASK-CHOICE-SPEC.md）──
  // ★ 归 `sessionId` 空间（与聊天事件同频道，不是独立频道）：选择的答案直接续进这一轮对话，
  //   因此不经 `pk:` 那套前缀隔离。三个事件覆盖一个提问的完整生命周期：
  //   asked（弹卡）→ replied（切已选态）/ cancelled（切作废态，逃生口触发）。
  | { type: 'choice-asked'; seq: number; sessionId: string; request: AskChoiceRecord }
  | { type: 'choice-replied'; seq: number; sessionId: string; requestId: string; reply: AskChoiceReply }
  | { type: 'choice-cancelled'; seq: number; sessionId: string; requestId: string; reason: string }
  // ── AI 主动发起对战（PK-SPEC §16，2026-09-24 老板点单）──────────────────────
  // ★ 归 `sessionId` 空间（与 `choice-*` 同频道）而**不是 `pk:` 频道**：发出邀请那一刻房间
  //   还不存在，`pk:<roomId>` 无从算起（契约 §16.5）。房间是用户点「接受」之后才建的。
  // ★ 载荷只有 topic / reason / status，**不含任何题目与答案** ⇒ 与「正确答案永不下发」（§1
  //   决策⑫）无冲突：那条管的是判分与答案，「有人想跟你打」是双方都该看到的公开事实。
  // ★ `pk-invite-decided` 带 `roomId`（accepted 时是刚建好的那间，rejected 恒 null）：
  //   另一端点掉「接受」时，本端的卡要能变成「进入对局」的入口而不是一句「已开始」——
  //   没有这个字段，回执卡上的链接无处可取（邀请帧里那份 `invite` 在点之前 roomId 还是 null）。
  // ★ 卡片**不落 `messages`** ⇒ 刷新/重连要靠 `GET /api/pk/invites/pending` 捞回（同 `ask_choices`）。
  | { type: 'pk-invite-asked'; seq: number; sessionId: string; invite: PkInviteRecord }
  | {
      type: 'pk-invite-decided';
      seq: number;
      sessionId: string;
      inviteId: string;
      status: PkInviteStatus;
      roomId: string | null;
    }
  // ── 督促趋势卡（记忆联动 P4，契约 docs/MEMORY-TREND-SPEC.md §4.4）──────────────
  // ★ 服务端定时生成一张趋势卡后**主动推**给前端，前端据此在胶囊旁冒一个小气泡
  //   （「你的近期学习趋势生成了！」）。★ 复用既有 `coach:<owner>` 频道、**不新造通道**，
  //   故字段名沿用 `sessionId`（与其余督促事件一致），与会话 id、PK 的 `pk:` 三向隔离。
  // ★ 只对 `trend` 卡发这个事件：`nudge` 的红点语义已经在胶囊上，两者叠加会让胶囊
  //   同时"报数 + 报消息"，用户分不清哪个更急（契约 §4.4 末条）。
  | { type: 'coach-card'; seq: number; sessionId: string; card: CoachTrendCard }
  // ── 词条卡牌（2026-09-25 登记，契约 docs/TERM-CARDS-SPEC.md §7.2）────────────────
  // ★ 三条事件走**独立频道** `cardsChannel(ownerId)`（helper 见 `term-cards.ts`），
  //   与聊天 `sessionId`、PK 的 `pk:`、督促的 `coach:` 四向隔离。★ 字段名仍叫 `sessionId`
  //   不是笔误：`chat/sse-bus.ts` 的键是 channel-agnostic 的任意字符串（督促趋势卡同一先例），
  //   换名要把总线一起改，而总线几年不动一次。
  // ★ **为什么 `card_granted` 也走推送**：它是 T1（每天上百次），本可以纯靠前端在聊天流里
  //   顺带显示；但卡牌的账在服务端（两张流水的聚合），前端猜就会出现「聊天说命中 3 个、
  //   卡墙只加 2 张」——B-007/009/010「前端猜服务端事实」同族病。★ 所以它**只报数、不带动画指令**
  //   （契约 §8 的 T1 预算：数字跳一下即可，飞卡动画属纯装饰且频次过高）。
  | {
      type: 'card_granted';
      seq: number;
      sessionId: string;
      /** 本轮各词条的**绝对卡数**（不是增量）：断线重连后重放一条即可对齐，无需前端累加 */
      grants: Array<{ termId: string; cards: number; star: number }>;
      /** 卡数统计起点（首条流水的本地日历日，契约 §7.4——「提及 20 次但只有 8 张卡」要能自解释） */
      logSince: string | null;
    }
  // ★ 派单（T2）：只推「有新单」这一件事，正文让前端回读 `/state`。
  //   不在事件里塞任务全文——否则重连重放 + 轮询补拉会拿到两份可能不同的文本，
  //   而按 id 合并的前提是"同一条内容相同"（`coach-cards.test.ts` 三条路径的教训）。
  | {
      type: 'task_dispatched';
      seq: number;
      sessionId: string;
      added: number;
      taskIds: string[];
    }
  // ★ 宝箱就绪（T3）：一天一次的事件，值得带内容
  | {
      type: 'chest_ready';
      seq: number;
      sessionId: string;
      openedDay: string;
      left: number;
    }
  // ── 工具确认门（P3，2026-09-19 登记，契约 TOOL-ECOSYSTEM-SPEC §4.6/§6.4）──────────
  // ★ 归 `sessionId` 空间、与 choice-asked 家族同形：两阶段的写（planWrite 出方案）触到
  //   确认门时服务端发 request，用户回执或服务端 60s 超时（按拒绝，保守档）发 resolved。
  //   前端不本地判超时——expiresAt 只做倒计时显示，裁决权在服务端定时器（单一裁决者）。
  //   request/resolved 按 requestId 配对；resolved 未到前确认卡不许自行动作（防双击竞态）。
  | {
      type: 'tool-confirm-request';
      seq: number;
      sessionId: string;
      requestId: string;
      tool: string;
      source: 'builtin' | 'mcp';
      /** 仅 MCP 带（server 名）：内置工具省略 */
      server?: string;
      /** 动作一句话（§5.1 卡硬要求①） */
      actionSummary: string;
      /** 将要改动的条数；items ≤8 行×≤40 字清单，超出折叠「…等 N 条」 */
      affected: number;
      items: string[];
      /** 绝对过期时刻（ms）：前端倒计时基准；到期由服务端代答 decision:'timeout' */
      expiresAt: number;
    }
  | {
      type: 'tool-confirm-resolved';
      seq: number;
      sessionId: string;
      requestId: string;
      decision: ToolConfirmDecision;
    }
  | { type: 'ping' };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  source: 'provider' | 'estimated';
}
