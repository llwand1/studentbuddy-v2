/**
 * chat/follow-up —— 「向 AI 追问」：**原对话摘要 + 组装首问 + 建 fork 会话**
 * （契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §4 / §5）。
 *
 * 本文件是**纯装配**：它不调模型、不写图、不推流。流由 `chat/flow.ts` 跑。
 * （原先回复收尾还有一步「与源词条连星型边」——2026-09-25 随「学习流＋知识图」功能整体
 *   下线删除，批次 K。）各方单一职责，谁也不替谁做事。
 *
 * ★★ 两个最容易被做错的点（都写在契约里，这里再点一次）：
 *
 * ① **摘要优先复用 `sessions.summary`（免费的那一档）**，而不是现调一次 LLM。
 *    `chat/compact.ts` 早就把真摘要写进库了（v10 加的列），而"现摘要"会把 2~5 秒的模型调用
 *    **同步阻塞在用户点击与首个 token 之间**——这个功能的全部体验价值就在"点完立刻开聊"。
 *    长会话命中第 ① 档（免费），短会话走第 ② 档（抽取式摘录，本来就短、信息量不差）。
 *
 * ② **第 ② 档必须在正文里自称"摘录（未压缩）"**。不写的话模型会把摘录当完整上下文，
 *    对"你之前说过什么"做过度推断，而我们无从纠正（用户看不见 prompt 里的谎）。
 *    能省的只有字数，不能省的是诚实（ADR-5）。
 *
 * ★ 首问正文是**服务端生成、并且会被原样落库**的：用户会在屏上看到这一整段。
 *   这是**故意的**——用户有权一眼看出"这次追问把什么上下文带过去了"，而不是面对黑盒。
 *   也正因如此，这里是**唯一**需要小心措辞的地方：它同时是"给模型的指令"和"给用户看的交代"。
 */
import { randomUUID } from 'node:crypto';
import { defaultFollowUpQuestion, followUpTitle, type FollowUpResult, type FollowUpSummarySource } from '@sb/shared';
import { insertSession } from '../auth/ownership.js';
import { findTermByName, type TermRow } from '../learning/terms.js';
import { loadHistory } from './persist.js';
import { loadSessionSummary } from './compact.js';
import { contentToText } from '../llm/types.js';

/**
 * 带过去的上下文长度上限。
 * ★ 取 2000 而不是复用 `SUMMARY_MAX_CHARS`(4000)：追问的正文还要装词条、释义与用户问题，
 *   而摘要是"背景"不是"主角"。4000 字的背景会把真正的追问淹掉。
 */
export const FOLLOW_UP_SUMMARY_MAX_CHARS = 2000;
/** 第 ② 档（摘录）取最近多少条**非 tool** 消息。8 ≈ 4 轮来往，够交代"刚才在聊什么" */
const RECENT_TURNS = 8;
/** 摘录时单条消息的长度上限（截断；摘录的目的就是压长度） */
const RECENT_MSG_MAX_CHARS = 300;

export interface FollowUpContext {
  /** 组装好的上下文正文（`source==='none'` 时为空串） */
  summary: string;
  source: FollowUpSummarySource;
}

function clipChars(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** 把一条消息压成一行（换行会让 prompt 的块结构失去边界） */
function oneLine(text: string): string {
  return clipChars(text.replace(/\s+/g, ' ').trim(), RECENT_MSG_MAX_CHARS);
}

/** 第 ② 档：最近若干条对话的**抽取式**摘录（不是摘要，别在文案里冒充，见文件头 ②） */
function recentDigest(sessionId: string): string {
  // tool 消息是过程态（工具回灌原文），对"刚才在聊什么"没有信息量，且体积最大 ⇒ 排除
  const msgs = loadHistory(sessionId).filter((m) => m.role !== 'tool');
  if (msgs.length === 0) return '';
  return msgs
    .slice(-RECENT_TURNS)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${oneLine(contentToText(m.content))}`)
    .filter((line) => line.length > 3) // 「用户：」这种空壳行不占位置
    .join('\n');
}

/**
 * 三档取摘要（契约 §4）。**顺序不可换**：先用免费的已有摘要，再退到摘录，最后如实留空。
 * ★ 三档都不抛异常：拉不到就降级，追问本身不该因为"摘要取不到"而失败。
 */
export function buildFollowUpContext(parentSessionId: string): FollowUpContext {
  const { summary } = loadSessionSummary(parentSessionId);
  const trimmed = summary.trim();
  if (trimmed) return { summary: clipChars(trimmed, FOLLOW_UP_SUMMARY_MAX_CHARS), source: 'compact' };
  const digest = recentDigest(parentSessionId);
  if (digest) return { summary: clipChars(digest, FOLLOW_UP_SUMMARY_MAX_CHARS), source: 'recent' };
  return { summary: '', source: 'none' };
}

/**
 * 组装首问（契约 §5.3）。这一整段会被落库成 fork 会话的第一条 user 消息。
 *
 * ★ `source==='none'` 时**整块省略**上下文——不写「（无摘要）」这种占位噪声：
 *   那对模型是零信息，对用户是一句无谓的免责声明。
 */
export function composeFollowUpPrompt(input: {
  term: string;
  item?: TermRow | null | undefined;
  question: string;
  context: FollowUpContext;
}): string {
  const { term, item, question, context } = input;
  const head = item
    ? `我正在学习词条「${term}」（领域：${item.domain}）。\n它的释义是：${item.definition || '（词条库尚未填写释义）'}`
    : `我正在学习词条「${term}」。`;
  const block =
    context.source === 'compact'
      ? `\n\n【原对话摘要】\n${context.summary}`
      : context.source === 'recent'
        ? `\n\n【原对话摘录（未压缩）】\n${context.summary}`
        : '';
  return `${head}${block}\n\n请针对上面这个词条回答我的追问：${question}`;
}

/**
 * 建 fork 会话（**只建行，不起流**）。
 *
 * ★ 首问**不在这里落库**：交给 `handleMessage` 的正常链路去落（路由起流时不传 `skipUserPersist`）。
 *   于是它**就是**会话的第一条 user 消息——用户看得见、可编辑重发、历史回放一致。
 *   服务端偷偷塞一条消息会造出一份影子状态（回放与实时不一致，且用户改不动它）。
 * ★ 标题**必须不是** `'新对话'`：`chat/flow.ts` 有一条「title 还是默认值就用首句覆盖」的逻辑，
 *   用默认值会被这一长段首问正文冲掉（"追问：闭包"变成半截 prompt 当标题）。
 */
export function createFollowUpSession(input: {
  parentSessionId: string;
  term: string;
  question?: string | undefined;
  ownerId: string | null;
}): { result: FollowUpResult; prompt: string } {
  const term = input.term.trim();
  const context = buildFollowUpContext(input.parentSessionId);
  const item = findTermByName(term, input.ownerId);
  const question = input.question?.trim() || defaultFollowUpQuestion(term);
  const prompt = composeFollowUpPrompt({ term, item, question, context });
  const sessionId = randomUUID();
  const title = followUpTitle(term);
  insertSession(sessionId, input.ownerId, title, { fromSessionId: input.parentSessionId, term });
  return {
    result: { sessionId, title, forkedFromId: input.parentSessionId, term, summarySource: context.source },
    prompt,
  };
}
