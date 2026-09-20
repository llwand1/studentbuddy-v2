/**
 * follow-up —— 「向 AI 追问」的出入参契约（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md`）。
 *
 * 这条链路做三件事：**开一个 fork 会话**（`sessions.forked_from_id` + `forked_term`）、
 * **把原对话摘要带过去**、回答落库后**自动与源词条连边**（`knowledge_edge.origin='ai'`）。
 * 前两件属于本文件（请求/响应形状），第三件在服务端 `learning/follow-up-links.ts`。
 *
 * ★ 三条与别处**看起来不一致、实则有意**的口径（都被契约 §5.1 记过账）：
 *  1. `term` 超长**拒绝**（400），不截断；而 `question` 超长**截断**。
 *     判据是污染半径：坏词条名 ⇒ 连到错误的图上节点（不可自愈的脏数据）；
 *     坏问题文本 ⇒ 只是这一次问得不完整（可重问）。同仓先例是 `normalizeSpeechSettings`
 *     的 `voiceName`（超长回落空串）：那也按"污染半径"判，只是半径更小。
 *  2. `question` 非字符串**当缺省处理**（不报错），`term` 非字符串**报错**——
 *     前者是可选润色，后者是这条链路的**主语**，没有它整件事没有意义。
 *  3. 本文件的归一**从不抛异常**（返回判别联合）：路由层据此回 400，
 *     不让一个坏 body 变成 500（同 `normalizeSpeechSettings` / `normalizeVerdict` 手法）。
 */

/** 词条名长度上限。超了拒绝（理由见文件头 ★1） */
export const FOLLOW_UP_TERM_MAX = 120;
/** 追问问题长度上限。超了截断（理由见文件头 ★1） */
export const FOLLOW_UP_QUESTION_MAX = 2000;
/** fork 会话标题前缀。**带冒号**——侧栏里要一眼看出"这是追问出来的" */
export const FOLLOW_UP_TITLE_PREFIX = '追问：';
/** 标题长度上限（`term` 已 ≤120，但标题还要放前缀，且侧栏会被 CSS 截断，故再收一道） */
export const FOLLOW_UP_TITLE_MAX = 40;

/**
 * 摘要出处（契约 §4 三档）。
 * ★ 它要**下发给前端**：用户有权知道"这次追问到底把什么带过去了"。
 *   `none` 不是错误——原会话还没有任何消息（从空会话点追问），如实留空。
 */
export type FollowUpSummarySource = 'compact' | 'recent' | 'none';

export interface FollowUpRequest {
  /** 被追问的源词条名（必填，非空） */
  term: string;
  /** 用户的具体追问；缺省 = 由 `defaultFollowUpQuestion` 补一个通用问法 */
  question?: string;
}

/** `POST /api/sessions/:id/fork` 的成功响应 */
export interface FollowUpResult {
  /** 新建的 fork 会话 id（前端据此切过去） */
  sessionId: string;
  /** 会话标题（`追问：<term>`，已按 FOLLOW_UP_TITLE_MAX 截断） */
  title: string;
  /** 父会话 id（= 路径参数 :id） */
  forkedFromId: string;
  /** 源词条名（抗删快照口径，与 `sessions.forked_term` 一致） */
  term: string;
  /** 本次带过去的上下文是哪一档（契约 §4） */
  summarySource: FollowUpSummarySource;
}

/** 归一失败时的错误码语义（路由层直译为 400） */
export interface FollowUpRejection {
  ok: false;
  error: string;
}

/**
 * 组装 fork 会话标题。
 * ★ 空词条名不该走到这里（归一已拦），但仍兜住：退回不带词条的裸前缀，
 *   而不是产出 `追问：undefined` 那种脏标题。
 */
export function followUpTitle(term: string): string {
  const t = term.trim();
  if (!t) return FOLLOW_UP_TITLE_PREFIX.slice(0, -1); // 去掉冒号，得到「追问」
  const head = `${FOLLOW_UP_TITLE_PREFIX}${t}`;
  return head.length <= FOLLOW_UP_TITLE_MAX ? head : `${head.slice(0, FOLLOW_UP_TITLE_MAX - 1)}…`;
}

/**
 * 用户没填问题时的默认问法。
 * ★ 刻意写成"要求讲透 + 联系上下文"而不是干巴巴的「解释一下」：
 *   后者在已经带过去摘要的情况下是资源浪费（模型会把摘要当摆设）。
 */
export function defaultFollowUpQuestion(term: string): string {
  const t = term.trim() || '这个词条';
  return `请把「${t}」讲透：它是什么、为什么重要、和上面这段对话里聊到的内容是什么关系。`;
}

/**
 * 归一请求体（从不抛，返回判别联合）。
 * 逐字段独立判定：`term` 不合格 ⇒ 整体拒绝；`question` 不合格 ⇒ 降级为缺省，不影响 `term`。
 */
export function normalizeFollowUpRequest(raw: unknown): { ok: true; value: FollowUpRequest } | FollowUpRejection {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '请求体必须是对象' };
  }
  const src = raw as { term?: unknown; question?: unknown };
  if (typeof src.term !== 'string') return { ok: false, error: 'term 必填且必须是字符串' };
  const term = src.term.trim();
  if (!term) return { ok: false, error: 'term 不能为空' };
  if (term.length > FOLLOW_UP_TERM_MAX) {
    // 拒绝而不截断：截断会连到错误的图上节点，且不可自愈（契约 §5.1）
    return { ok: false, error: `term 过长（上限 ${FOLLOW_UP_TERM_MAX} 字）` };
  }
  const q = src.question;
  // 非字符串当缺省：可选润色字段不该让整次追问失败
  const question = typeof q === 'string' ? q.trim().slice(0, FOLLOW_UP_QUESTION_MAX) : '';
  return { ok: true, value: question ? { term, question } : { term } };
}
