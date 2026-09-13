/**
 * api — REST 封装（同源经 vite proxy；错误统一抛 ApiError，UI 层可见可重试，ADR-5）。
 */
import type {
  StatusResponse,
  Session,
  Provider,
  ModelRole,
  QuizMix,
  AnswerStyle,
  QuizNote,
  QuizNoteSummary,
  PkIdentity,
  PkRoomState,
} from '@sb/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  /** 通用请求（页面内直接用） */
  request,

  status: () => request<StatusResponse>('/api/status'),

  /** PK 登录与房间（契约 docs/PK-SPEC.md §2.1）：P0 模拟登录，P1 换真微信授权时签名不变 */
  pk: {
    login: (nickname: string, userId?: string) =>
      request<PkIdentity>('/api/pk/auth/login', {
        method: 'POST',
        body: JSON.stringify({ nickname, ...(userId ? { userId } : {}) }),
      }),
    /** 启动时校验本地登录态；404（账号不存在）由调用方按需清除 */
    me: (userId: string) => request<PkIdentity>(`/api/pk/auth/me?userId=${encodeURIComponent(userId)}`),
    /** 建房：已在某 waiting 房则服务端幂等返回原房；mode='pve' 为 AI 对战（第二座位自动归 AI） */
    createRoom: (userId: string, mode: 'pvp' | 'pve' = 'pvp', aiTopic?: string) =>
      request<{ roomId: string; roomCode: string; state: PkRoomState }>('/api/pk/rooms', {
        method: 'POST',
        body: JSON.stringify({ userId, mode, ...(aiTopic ? { aiTopic } : {}) }),
      }),
    /** 按房号入房：404 房不存在 / 409 房满或已开局 */
    joinRoom: (roomCode: string, userId: string) =>
      request<{ roomId: string; state: PkRoomState }>('/api/pk/rooms/join', {
        method: 'POST',
        body: JSON.stringify({ roomCode, userId }),
      }),
    /** 开局（仅房主、双方已进房） */
    startRoom: (roomId: string, userId: string) =>
      request<{ state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/start`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }),
    /** 全量快照（轮询兜底 / 断线重连对齐用）；404 = 房不存在或已被 TTL 回收 */
    roomState: (roomId: string) =>
      request<{ state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/state`),
    /** 出题（AI 生成耗时数秒为正常）；429 = CD 内，502 = AI 失败（CD 已回滚，免费重试） */
    submitQuiz: (roomId: string, userId: string, prompt: string) =>
      request<{ state: PkRoomState }>(`/api/pk/rooms/${encodeURIComponent(roomId)}/quiz`, {
        method: 'POST',
        body: JSON.stringify({ userId, prompt }),
      }),
    /** 答题：立即判分 { correct, delta, score }；409 = 已答/已超时 */
    submitAnswer: (roomId: string, userId: string, questionId: string, choice: number) =>
      request<{ correct: boolean; delta: number; score: number }>(
        `/api/pk/rooms/${encodeURIComponent(roomId)}/answer`,
        { method: 'POST', body: JSON.stringify({ userId, questionId, choice }) },
      ),
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
          created_at: string;
        }>
      >(`/api/sessions/${id}/messages`),
  },

  chat: {
    send: (sessionId: string, text: string) =>
      request<{ ok: boolean }>('/api/chat/send', {
        method: 'POST',
        body: JSON.stringify({ sessionId, text }),
      }),
    abort: (sessionId: string) =>
      request<{ ok: boolean }>('/api/chat/abort', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      }),
    /** 重新生成：服务端作废最后一条提问之后的全部产物并重跑（提问不重复落库） */
    regenerate: (sessionId: string) =>
      request<{ ok: boolean }>('/api/chat/regenerate', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      }),
    /** 编辑重发：把最后一条提问改成新文案后重跑（旧回答及工具轮作废） */
    resend: (sessionId: string, text: string) =>
      request<{ ok: boolean }>('/api/chat/resend', {
        method: 'POST',
        body: JSON.stringify({ sessionId, text }),
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

  settings: {
    searchKeys: () => request<{ configured: Record<'exa' | 'tavily' | 'zhipu', boolean> }>('/api/settings/search-keys'),
    saveSearchKeys: (patch: Partial<Record<'exa' | 'tavily' | 'zhipu', string>>) =>
      request<{ ok: boolean; configured: Record<'exa' | 'tavily' | 'zhipu', boolean> }>('/api/settings/search-keys', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    testSearch: (query?: string) =>
      request<{ ok: boolean; count: number; providers: string[]; failed: string[] }>('/api/settings/search/test', {
        method: 'POST',
        body: JSON.stringify({ query }),
      }),
    /** 出题题型配比：设置页读写，服务端归一回读；对话页/题库页只读这份全局配比 */
    quizMix: () => request<{ mix: QuizMix }>('/api/settings/quiz-mix'),
    saveQuizMix: (mix: QuizMix) =>
      request<{ mix: QuizMix }>('/api/settings/quiz-mix', { method: 'PUT', body: JSON.stringify({ mix }) }),
    /** 出题配图开关：设置页读写（契约 docs/QUIZ-IMAGE-SPEC.md） */
    quizImage: () => request<{ on: boolean }>('/api/settings/quiz-image'),
    saveQuizImage: (on: boolean) =>
      request<{ ok: boolean; on: boolean }>('/api/settings/quiz-image', { method: 'PUT', body: JSON.stringify({ on }) }),
    /** 回答方式偏好（契约 docs/ANSWER-STYLE-SPEC.md）：configured 是「出题前要不要问」的开关量 */
    answerStyle: () => request<{ style: AnswerStyle; configured: boolean }>('/api/settings/answer-style'),
    saveAnswerStyle: (style: AnswerStyle) =>
      request<{ style: AnswerStyle; configured: boolean }>('/api/settings/answer-style', {
        method: 'PUT',
        body: JSON.stringify({ style }),
      }),
    /** 恢复默认＝删键，回到「没配过」态（不是把四维写成默认值，那样 configured 仍为 true） */
    resetAnswerStyle: () =>
      request<{ style: AnswerStyle; configured: boolean }>('/api/settings/answer-style', { method: 'DELETE' }),
  },

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
    domains: () =>
      request<{ total: number; domains: Array<{ domain: string; count: number }>; today: number }>('/api/terms/domains'),
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
}
