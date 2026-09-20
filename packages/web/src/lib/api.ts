/**
 * api — REST 封装（同源经 vite proxy；错误统一抛 ApiError，UI 层可见可重试，ADR-5）。
 */
import type {
  StatusResponse,
  Session,
  Provider,
  ModelRole,
  QuizNote,
  QuizNoteSummary,
  PkIdentity,
  PkRoomState,
  PkJudgeAdvice,
  PkQuestion,
  PkMatchRecord,
  PkMatchDetail,
  PkQuizKind,
  AskChoiceRecord,
  FollowUpResult,
} from '@sb/shared';

import { ApiError, request } from './api-request.js';
import { settingsApi } from './api-settings.js';
import { authApi } from './api-auth.js';
import { termsDomainApi } from './api-terms-domain.js';
import { termsReviewApi } from './api-terms-review.js';
import { studyFlowApi } from './api-study-flow.js';
import { toolsApi, termsUndoApi } from './api-tools.js';
import { searchApi } from './api-search.js';

// 领域的类型**转出**给调用方（形状定义在 `api-terms-domain.ts`，那里承担行数红线的解释）。
export type { DomainRow, DomainsResponse, RenameDomainResult, RemoveDomainResult } from './api-terms-domain.js';
// 复习的类型同源转出（v23 艾宾浩斯，形状定义在 `api-terms-review.ts`）。
export type { ReviewTermItem, ReviewQueueItem, ReviewQueueResult, ReviewOverview, ReviewDayStat } from './api-terms-review.js';

// `ApiError` 已抽到 api-request.ts（行数红线 + 断环，见该文件头注释）。
// 此处**转出**以保持既有调用方 `import { api, ApiError } from '../../lib/api'` 零改动。
export { ApiError };

/**
 * 「向 AI 追问」这个**动作**的签名（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §6）。
 * 由 `App` 提供唯一实现（`api.sessions.fork` + 切到新会话 + 刷列表），任何页面注入给控件即可。
 *
 * ★ `fromSessionId` 省缺 ＝ **当前正在看的那条会话**——词条卡走的就是这条路（它在对话页里，
 *   "当前会话"是个明确的东西）。学习流页是另一个视图，用户此刻并没有"正在看的对话"，
 *   故它必须显式给：那一次运行的 `flow_run.session_id`（见 `study-flow/ProducedNodes.tsx` 文件头 ②）。
 * ★ 类型放这里而不是各组件内联：三个文件（App / FlowPage / ProducedNodes）都要用它，
 *   内联三次就是三份口径，将来加参数会漏改。
 */
export type FollowUpAction = (term: string, question?: string, fromSessionId?: string) => Promise<void>;

export const api = {
  /** 通用请求（页面内直接用） */
  request,

  status: () => request<StatusResponse>('/api/status'),

  /** 全站搜索（契约 docs/FTS-SPEC.md §3.4）：本地库 fts5 检索，与联网搜索的 key 配置无关 */
  search: searchApi,

  /**
   * 账号（契约 docs/AUTH-SPEC.md §2）。
   * ★ 形状定义在 `api-auth.ts`（行数红线 + M1.6 的破坏性变更集中一处），此处只做转发。
   */
  auth: authApi,

  /**
   * PK 房间与对局（契约 docs/PK-SPEC.md §2 / §14.1）。
   * ★ B1（§14.1，2026-09-20）起身份并入统一账号：**所有请求不带 userId**——
   *   「我是谁」由 httpOnly cookie 会话在服务端裁定（`req.authUser`），客户端自报无效。
   *   未登录请求 → 401 `UNAUTHENTICATED`（去登录，见 PkLobby 的引导）。
   */
  pk: {
    /** 当前 PK 身份（前端启动时问一次）；401 = 未登录（cloud 形态） */
    me: () => request<PkIdentity>('/api/pk/auth/me'),
    /**
     * 建房：已在某 waiting 房则服务端幂等返回原房；mode='pve' 为 AI 对战（第二座位自动归 AI）。
     * P0-7：`topic` = 建房人选定的**对战主题**（入房的人走 `setTopic` 端点补选自己的）。
     */
    createRoom: (mode: 'pvp' | 'pve' = 'pvp', aiTopic?: string, topic?: string) =>
      request<{ roomId: string; roomCode: string; state: PkRoomState }>('/api/pk/rooms', {
        method: 'POST',
        body: JSON.stringify({ mode, ...(aiTopic ? { aiTopic } : {}), ...(topic ? { topic } : {}) }),
      }),
    /** 按房号入房：404 房不存在（含邀请已过期）/ 409 房满或已开局 */
    joinRoom: (roomCode: string) =>
      request<{ roomId: string; state: PkRoomState }>('/api/pk/rooms/join', {
        method: 'POST',
        body: JSON.stringify({ roomCode }),
      }),
    /** 开局（仅房主、双方已进房） */
    startRoom: (roomId: string) =>
      request<{ state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/start`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    /** 全量快照（轮询兜底 / 断线重连对齐用）；404 = 房不存在或已被 TTL 回收 */
    roomState: (roomId: string) =>
      request<{ state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/state`),
    /** 出题（AI 生成耗时数秒为正常）；429 = CD 内，502 = AI 失败（CD 已回滚，免费重试）。
     * qKind（§15 B2/B4）：单选/判断/情景现选，省略＝单选（服务端兜底）。§15 B3 `termIds`：
     * 词条硬绑定（≤5，服务端校验）；**空数组时不带该字段**——请求体与 B3 之前逐字一致（T6 锁）。 */
    submitQuiz: (roomId: string, prompt: string, qKind: PkQuizKind = 'single', termIds: string[] = []) =>
      request<{ state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/quiz`, {
        method: 'POST',
        body: JSON.stringify({ prompt, qKind, ...(termIds.length ? { termIds } : {}) }),
      }),
    /** §15.4 B4：回传情景题一个评分点的「发生了什么」→ 服务端按 criteria 判 → { correct }；observed 原样透传，重报以最后一次为准 */
    reportScenario: (roomId: string, questionId: string, taskId: string, observed: unknown) =>
      request<{ correct: boolean }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/scenario-report`, {
        method: 'POST', body: JSON.stringify({ questionId, taskId, observed }),
      }),
    /** §15.4 B4：情景题 demo 页地址（宿主 iframe 挂它；仅对局双方可取） */
    scenarioDemoUrl: (roomId: string, demoId: string) =>
      `/api/pk/rooms/${encodeURIComponent(roomId)}/scenario/${encodeURIComponent(demoId)}`,
    /** 答题：立即判分 { correct, delta, score }；409 = 已答/已超时 */
    submitAnswer: (roomId: string, questionId: string, choice: number) =>
      request<{ correct: boolean; delta: number; score: number }>(
        `/api/pk/rooms/${encodeURIComponent(roomId)}/answer`,
        { method: 'POST', body: JSON.stringify({ questionId, choice }) },
      ),
    /** 选定本人对战主题（仅开局前可改）：400 主题为空 / 409 已开局 */
    setTopic: (roomId: string, topic: string) =>
      request<{ state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/topic`, {
        method: 'POST',
        body: JSON.stringify({ topic }),
      }),
    /** 求助道具（每局 1 个）：裁判当场联网搜索，给建议 + 知识输出（**不给答案**）；409 = 已用完 */
    useHelp: (roomId: string, questionId: string) =>
      request<{ advice: PkJudgeAdvice; state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/help`, {
        method: 'POST',
        body: JSON.stringify({ questionId }),
      }),
    /** 错题二次机会（3 分钟 CD）：给现场解析 + 同主题类似题；429 = CD 中，502 = 裁判不可用 */
    requestRetry: (roomId: string, questionId: string) =>
      request<{ explanation: string; question: PkQuestion | null; state: PkRoomState }>(
        `/api/pk/rooms/${encodeURIComponent(roomId)}/retry`,
        { method: 'POST', body: JSON.stringify({ questionId }) },
      ),
    /** P0-8 认输：对手直接胜、比分定格；403 = 你不在房里，409 = 对局已不在进行中 */
    forfeit: (roomId: string) =>
      request<{ state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/forfeit`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    /** P0-8 我的对战历史（最近的在前）；limit 由服务端归一（缺省 20 / 上限 100）；归属只认会话 */
    matches: (limit?: number) =>
      request<{ matches: PkMatchRecord[] }>(`/api/pk/matches${limit ? `?limit=${limit}` : ''}`),
    /** P0-8 历史详情（含末快照，供题目回看）；不存在或不是你的 → 404 */
    matchDetail: (id: string) =>
      request<{ match: PkMatchDetail }>(`/api/pk/matches/${encodeURIComponent(id)}`),
  },

  sessions: {
    list: () => request<Session[]>('/api/sessions'),
    create: () => request<Session>('/api/sessions', { method: 'POST' }),
    remove: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
    /** 置顶/取消置顶：列表已按 pinned DESC 排序（服务端），这里只切值 */
    pin: (id: string, pinned: boolean) =>
      request<{ ok: boolean; pinned: boolean }>(`/api/sessions/${id}/pinned`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned }),
      }),
    /**
     * 历史消息：过程字段（tool_calls/tool_call_id = 工具卡片；reasoning/tasks = 思考与任务清单）
     * 是过程式 UI 唯一的持久化来源，必须一并下发。
     */
    messages: (id: string) =>
      request<
        Array<{
          id: string;
          role: string;
          content: string;
          tool_calls: string | null;
          tool_call_id: string | null;
          reasoning: string | null;
          tasks: string | null;
          /** v17 看图：用户上传图片（base64 dataURL JSON 数组），仅作缩略图回显 */
          images: string | null;
          created_at: string;
        }>
      >(`/api/sessions/${id}/messages`),
    /**
     * 「向 AI 追问」（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §5）：从本会话**分叉**出一个
     * 专门深挖 `term` 的新会话，并在服务端立刻起流（回答走既有的会话 SSE）。
     * 调用方拿返回的 `sessionId` 切过去即可，不需要自己再发一条消息。
     * ★ `question` 可省：服务端补 `defaultFollowUpQuestion(term)` 的通用问法。
     * ★ 空 `question` 传 `undefined` 而不是空串——服务端把空串也当缺省，但少一个字段少一次歧义。
     */
    fork: (id: string, term: string, question?: string) =>
      request<FollowUpResult>(`/api/sessions/${id}/fork`, {
        method: 'POST',
        body: JSON.stringify(question ? { term, question } : { term }),
      }),
  },

  chat: {
    send: (
      sessionId: string,
      text: string,
      images?: Array<{ dataUrl: string; name?: string }>,
      /** v18 grill-me：本轮强制出选择框（开场问方向 + 收尾问下一步） */
      grillMe?: boolean,
      /** v18.4 联网开关（UI「联网已开」pill）：本轮首轮强绑 search_web（服务端 chat/opening.ts） */
      online?: boolean,
    ) =>
      request<{ ok: boolean }>('/api/chat/send', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          text,
          ...(images && images.length > 0 ? { images } : {}),
          ...(grillMe ? { grillMe: true } : {}),
          ...(online ? { online: true } : {}),
        }),
      }),
    abort: (sessionId: string) =>
      request<{ ok: boolean }>('/api/chat/abort', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      }),
    /**
     * 正在生成回复的会话 id（侧栏「回复中」提示的事实源）。
     * ★ 必须问服务端：生成**不随页面切换中止**（断开 SSE 只摘订阅者，flow 照跑照落库），
     * 客户端只知道「当前挂载的会话」在不在流，切走的那间无从判断。
     */
    active: () => request<{ sessionIds: string[] }>('/api/chat/active'),
    /** 重新生成：服务端作废最后一条提问之后的全部产物并重跑（提问不重复落库） */
    regenerate: (sessionId: string, online?: boolean) =>
      request<{ ok: boolean }>('/api/chat/regenerate', {
        method: 'POST',
        body: JSON.stringify({ sessionId, ...(online ? { online: true } : {}) }),
      }),
    /** 编辑重发：把最后一条提问改成新文案后重跑（旧回答及工具轮作废） */
    resend: (sessionId: string, text: string, online?: boolean) =>
      request<{ ok: boolean }>('/api/chat/resend', {
        method: 'POST',
        body: JSON.stringify({ sessionId, text, ...(online ? { online: true } : {}) }),
      }),
  },

  /**
   * 方案选择框（契约 docs/ASK-CHOICE-SPEC.md）：AI 主动提问、学习者点选、同轮继续。
   * `pending` 是「捞回挂起卡」的兜底——SSE 缓冲 60s 无订阅即回收，重开页面后回放流里
   * 可能已经什么都没有，只有主动查库才能把卡片恢复出来（详见 chat/choice.ts 的注释）。
   */
  choices: {
    pending: (sessionId: string) =>
      request<AskChoiceRecord[]>(`/api/choices?sessionId=${encodeURIComponent(sessionId)}`),
    reply: (requestId: string, reply: { optionId?: string; custom?: string }) =>
      request<AskChoiceRecord>(`/api/choices/${encodeURIComponent(requestId)}/reply`, {
        method: 'POST',
        body: JSON.stringify(reply),
      }),
    /** v18 跳过：真作废后端挂起的提问（只收起前端会让阻塞整轮的工具永久悬挂） */
    cancel: (requestId: string, reason?: string) =>
      request<AskChoiceRecord>(`/api/choices/${encodeURIComponent(requestId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ ...(reason ? { reason } : {}) }),
      }),
  },

  providers: {
    list: () => request<Array<Provider & { id: string }>>('/api/providers'),
    create: (p: { name: string; baseUrl: string; apiKey?: string; type?: string; streamMode?: string }) =>
      request<{ id: string }>('/api/providers', { method: 'POST', body: JSON.stringify(p) }),
    update: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean; streamMode?: string }) =>
      request<{ ok: boolean }>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    /** 该服务商的真实可用模型列表（拉取失败/不支持时为空数组，前端保留手填） */
    models: (id: string) => request<{ models: string[] }>(`/api/providers/${id}/models`),
    remove: (id: string) => request<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' }),
    roles: () =>
      request<{
        roles: Array<{ role: ModelRole; label: string }>;
        bindings: Array<{ role: string; provider_id: string; model: string }>;
      }>('/api/providers/roles'),
    bindRole: (role: string, providerId: string, model: string) =>
      request<{ ok: boolean }>(`/api/providers/roles/${role}`, {
        method: 'PUT',
        body: JSON.stringify({ providerId, model }),
      }),
  },

  settings: settingsApi,

  /** 刷题笔记（契约 docs/QUIZ-NOTES-SPEC.md）：草稿由 stats/record 自动落，这里只读/写心得/删 */
  notes: {
    list: (params?: { quizId?: string; wrong?: boolean }) => {
      const q = new URLSearchParams();
      if (params?.quizId) q.set('quizId', params.quizId);
      if (params?.wrong) q.set('wrong', '1');
      const qs = q.toString();
      return request<QuizNoteSummary[]>(`/api/notes${qs ? `?${qs}` : ''}`);
    },
    get: (id: string) => request<QuizNote>(`/api/notes/${encodeURIComponent(id)}`),
    saveBody: (id: string, body: string) =>
      request<{ ok: boolean }>(`/api/notes/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ body }),
      }),
    remove: (id: string) =>
      request<{ ok: boolean }>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },

  terms: {
    list: (domain?: string, keyword?: string) => {
      const q = new URLSearchParams();
      if (domain && domain !== 'all') q.set('domain', domain);
      if (keyword) q.set('keyword', keyword);
      const qs = q.toString();
      return request<TermItem[]>(`/api/terms${qs ? `?${qs}` : ''}`);
    },
    add: (term: string, definition: string, domain?: string) =>
      request<TermItem>('/api/terms', { method: 'POST', body: JSON.stringify({ term, definition, domain }) }),
    extract: (text: string, sourceSessionId?: string) =>
      request<{ added: number; items: TermItem[] }>('/api/terms/extract', {
        method: 'POST',
        body: JSON.stringify({ text, sourceSessionId }),
      }),
    update: (id: string, patch: { definition?: string; domain?: string; importance?: number }) =>
      request<TermItem>(`/api/terms/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string) => request<{ ok: boolean }>(`/api/terms/${id}`, { method: 'DELETE' }),

    // ── 领域（v19：与词条 CRUD 对等；可零词条存在）──
    // 统计 + 4 个写口整体在 `api-terms-domain.ts`（行数红线，见该文件头注释），此处只挂引用。
    ...termsDomainApi,

    // ── 复习（v23 艾宾浩斯遗忘曲线）──
    // 概览 / 队列 / 打卡，整体在 `api-terms-review.ts`（同上的行数红线），此处只挂引用。
    ...termsReviewApi,

    // ── 删除撤销（契约 §4.5；拍板⑯：AI 删除与 UI 手滑都进快照表）──
    ...termsUndoApi,
  },

  /** 文档模式：会话绑定一篇资料。三个接口都只过元信息，正文只在 set 时上一次行 */
  doc: {
    get: (sessionId: string) =>
      request<{ doc: DocMeta | null }>(`/api/doc?sessionId=${encodeURIComponent(sessionId)}`),
    set: (sessionId: string, name: string, text: string) =>
      request<{ doc: DocMeta }>('/api/doc', {
        method: 'POST',
        body: JSON.stringify({ sessionId, name, text }),
      }),
    clear: (sessionId: string) =>
      request<{ ok: boolean }>(`/api/doc?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  },

  /**
   * 学习流（契约 docs/STUDY-FLOW-SPEC.md）：控制流编排 + 知识数据图。
   * ★ 分组本体在 `api-study-flow.ts`（行数红线 + 断环，见该文件头注释），此处只挂引用。
   */
  studyFlow: studyFlowApi,

  /**
   * 工具生态（契约 TOOL-ECOSYSTEM-SPEC）：设置页阈值/统计 + 确认卡回执。
   * 形状与实现整体在 `api-tools.ts`（行数红线），此处只挂引用。
   */
  tools: toolsApi,
};

export interface DocMeta {
  name: string;
  chars: number;
  truncated: boolean;
}

export interface TermItem {
  id: string;
  term: string;
  definition: string;
  domain: string;
  /** 同义词别名（AI 整理时被并入的词名） */
  aliases: string[];
  source_session_id: string | null;
  source_title: string | null;
  importance: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  /** 复习阶段 0..MAX_REVIEW_STAGE（v23；0 = 还没复习过） */
  review_stage: number;
  /** 上次复习时间（null = 从未复习；起算点退到 created_at） */
  last_reviewed_at: string | null;
  /**
   * **有效**复习范围（v28）：1 = 该词条要复习。服务端现算
   * `COALESCE(词条覆盖位, 领域开关, 0)`，前端**只读结论、不自己算**
   * （自己 COALESCE 一次就是第二份范围口径，会出现「列表说不用背、队列里却有它」）。
   */
  review_in_scope: number;
  /** 词条级覆盖位（v28）：null = 继承领域开关。**别拿它判"复不复习"**，那是 review_in_scope 的事 */
  review_enabled: number | null;
}

// 领域的 4 个类型（DomainRow / DomainsResponse / RenameDomainResult / RemoveDomainResult）
// 定义在 `api-terms-domain.ts`，由本文件顶部 re-export（调用方 import 路径不变）。
