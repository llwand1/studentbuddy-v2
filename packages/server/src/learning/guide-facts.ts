/**
 * learning/guide-facts — 引路灯的「现场」（契约 `docs/GUIDE-SPEC.md` §6）。
 *
 * ★ 服务端自己从库里读，**不信客户端报的现场**：客户端只报它独有的两样——`can`（各组件此刻能做什么）与 `busy`；
 *   轮数、末几条消息、词条欠账、有无模型都在这里读。客户端要是能随口说「我已经聊了 50 轮」，
 *   阶段判定就成了一个可以被伪造的输入。
 * ★ 读不到就退零值，**永不抛**：引路灯是附加件，取数失败只让推荐变「通用」，不该把对话页的一次点击变成 500。
 * ★ 归属：会话按 `canAccessSession` 守（别人的会话 ⇒ 当没有）；`ownerId === null` 是本地单人模式，照常读。
 */
import { cleanGuideLine, type GuideChatFacts, type GuideFacts, type GuideNextRequest } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { canAccessSession, ownerFilter } from '../auth/ownership.js';
import { routeRole } from '../llm/router.js';
import { coachSnapshot } from './coach.js';
import { pomodoroFocus } from '@sb/shared';
import { loadPomodoro } from '../storage/pomodoro.js';
import { buildExamScopeLine } from './exam-mode.js';

/** 末一问 / 末一答放进提示词的字数上限（够判断话题，不把整段对话送出去） */
export const GUIDE_LAST_USER_MAX = 160;
export const GUIDE_LAST_ASSISTANT_MAX = 360;

/** 讲解角色有没有可用的模型（判法与等待时刷词一致：模型名与密钥都在才算） */
export function guideModelReady(ownerId: string | null): boolean {
  try {
    const t = routeRole('explain', undefined, ownerId);
    return !!(t?.model && t.apiKey);
  } catch {
    return false; // 读绑定表出错：按没模型处理（推荐退规则），不让引路灯把请求弄成 500
  }
}

function firstContent(sql: string, sessionId: string, max: number): string {
  const row = getDb().prepare(sql).get(sessionId) as { content: string } | undefined;
  return cleanGuideLine(row?.content ?? '', max);
}

/** 题卡 / 情景题登记行：assistant 角色、正文以这两个标记开头（契约 QUIZ-REVIEW-SPEC 与 SCENARIO-SPEC 的持久化载体） */
const REGISTRY_ROW = `(substr(content, 1, 6) = '[QUIZ]' OR substr(content, 1, 10) = '[SCENARIO]')`;

/** 当前会话的现场；没选会话 / 不归属 / 读失败 ⇒ null */
export function readGuideChatFacts(ownerId: string | null, sessionId: string | null | undefined): GuideChatFacts | null {
  if (!sessionId || !canAccessSession(sessionId, ownerId)) return null;
  try {
    const db = getDb();
    const rounds = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`).get(sessionId) as { n: number }).n;
    const quizzes = (
      db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'assistant' AND ${REGISTRY_ROW}`).get(sessionId) as { n: number }
    ).n;
    return {
      rounds,
      quizzes,
      lastUser: firstContent(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        sessionId,
        GUIDE_LAST_USER_MAX,
      ),
      // 末一答取真正的回答：跳过题卡登记行与纯工具轮（正文为空）
      lastAssistant: firstContent(
        `SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' AND content <> '' AND NOT ${REGISTRY_ROW} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        sessionId,
        GUIDE_LAST_ASSISTANT_MAX,
      ),
    };
  } catch (e) {
    console.warn('[guide] 读会话现场失败，按没有会话处理：', e instanceof Error ? e.message : e);
    return null;
  }
}

/** 词条欠账：与督促胶囊同一份快照（「一本账」，两处不各算一遍） */
export function readGuideTermFacts(ownerId: string | null): GuideFacts['terms'] {
  try {
    const s = coachSnapshot(ownerId);
    return { total: s.total, due: s.due, overdue: s.overdue, streak: s.streak };
  } catch (e) {
    console.warn('[guide] 读词条欠账失败，按零处理：', e instanceof Error ? e.message : e);
    return { total: 0, due: 0, overdue: 0, streak: 0 };
  }
}

function countSessions(ownerId: string | null): number {
  try {
    const f = ownerFilter(ownerId);
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL${f.sql}`).get(...f.params) as { n: number }).n;
  } catch {
    return 0;
  }
}

export function buildGuideFacts(ownerId: string | null, req: GuideNextRequest): GuideFacts {
  return {
    lang: req.lang,
    view: req.view,
    can: req.can,
    busy: req.busy === true,
    hasModel: guideModelReady(ownerId),
    // 只有对话页才谈得上「当前会话」；别的页带了 sessionId 也不理
    chat: req.view === 'chat' ? readGuideChatFacts(ownerId, req.sessionId) : null,
    terms: readGuideTermFacts(ownerId),
    sessions: countSessions(ownerId),
    focus: readGuideFocus(ownerId),
    examLine: buildExamScopeLine(ownerId),
  };
}

/** 番茄钟方向（契约 POMODORO-SPEC §5.4）：工作段才有；读失败按没开钟 */
export function readGuideFocus(ownerId: string | null): GuideFacts['focus'] {
  try {
    return pomodoroFocus(loadPomodoro(ownerId), new Date());
  } catch {
    return null;
  }
}
