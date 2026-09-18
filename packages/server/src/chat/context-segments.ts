/**
 * chat/context-segments — 一轮对话**附加 system 段**的唯一装配处。
 *
 * 【存在理由：同一份清单此前写了两遍】
 * 这几段原散在 `flow.ts` 里，而「有哪些段、按什么顺序」被手写了两遍——
 * 一遍在 `systemPromptTokens` 的预算核算里（7 项 `estimateTokens` 相加），
 * 一遍在 `messages` 的组装里（6 处 `push`/`splice` 加非空条件）。
 * 加一段就要同步改三处（预算项、组装语句、非空条件），漏一处**不报错、只静默漂**：
 *   · 预算漏算 ⇒ 窗口明明不够却按满额载历史（v1 老坑，见 `context.ts` 的 reserve 语义）
 *   · 组装漏写 ⇒ 段算进了预算却没上屏（白扣窗口，用户看不到那段指令）
 * 这与 `doc-rag.ts` 那次「前端手抄 60k 阈值」是同一类病：**双真相源**。
 * 故收成一份**有序清单**，预算与组装都从它派生。
 *
 * 【为什么单独开文件而不是留在 flow.ts】
 * `flow.ts` 已 396/400 贴线（AGENTS「贴线前先开新文件」，先例 `persist.ts` /
 * `quiz-image.ts` / `choice-tool.ts`）。搬迁后 flow 只留「调用一次」，
 * 各段的构造理由也终于有地方写全。
 *
 * ★ **数组顺序就是注入顺序**：`assembleContextMessages` 不做任何排序。
 *   要调顺序就调 `collectContextSegments` 里的字面量顺序——那才是唯一真相源。
 *   位置为什么不能随手改：`openai` 适配器把多段 system **全量透传**（`anthropic` 侧
 *   会合并成一段故无差异），所以位置对模型有语义；回归锁见 `flow.test.ts`
 *   的「长期记忆注入」describe（六段全满的顺序 + 画像段不插队）。
 */
import { buildAnswerStyleBlock } from '@sb/shared';
import { estimateTokens } from './context.js';
import { buildMemoryContext } from './compact.js';
import { choiceNudge } from './choice-nudge.js';
import { searchNudge } from './search-nudge.js';
import { buildDateBlock } from './date-context.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { getRelevantTerms } from '../learning/terms.js';
import { getSessionDoc, buildDocBlock } from '../learning/document.js';
import { loadAnswerStyle } from '../storage/answer-style.js';
import type { HistoryMessage } from './persist.js';
import type { ChatMessage } from '../llm/types.js';

/** 段身份。只表达「落位」与「是否可摘除」，**不参与排序**（顺序由清单字面量决定）。 */
export type ContextSegmentKind = 'summary' | 'date' | 'terms' | 'doc' | 'style' | 'memory' | 'nudge';

export interface ContextSegment {
  kind: ContextSegmentKind;
  content: string;
}

/**
 * 头部段在**历史之前**，其余段在历史之后。
 *
 * 差别不是风格，是**这段字在讲什么**：
 * · 头部段讲的是「这次对话的前提」——摘要段逻辑上是**历史的开头**（时间顺序：
 *   摘要 → 近期消息），它**替换掉的是历史本身**；日期段是对**基础提示词的补充**
 *   （基础提示词说「你是谁」，它说「今天是几号」），必须在模型读到任何历史之前就成立。
 * · 尾部段（词条/资料/偏好/画像/触发增强）是**辅助材料**，与历史并列，讲的是
 *   「回答这次提问时可以参考什么」。
 *
 * 位置为什么不能随手改：`openai` 适配器把多段 system **全量透传**（`anthropic` 侧会
 * 合并成一段故无差异），所以段的位置对模型有语义——回归锁见 `flow.test.ts` 的
 * 「长期记忆注入」describe 与 `context-segments.test.ts`。
 */
const HEAD_KINDS: ReadonlySet<ContextSegmentKind> = new Set<ContextSegmentKind>(['date', 'summary']);

/** 触发增强只作用于首轮，需留引用以便首轮结束后精确摘除。 */
const REMOVABLE_KINDS: ReadonlySet<ContextSegmentKind> = new Set<ContextSegmentKind>(['nudge']);

export interface ContextInputs {
  /** 全量历史（带 rowid）；本函数内部按摘要锚点过滤掉已被覆盖的部分 */
  history: HistoryMessage[];
  sessionId: string;
  /** 本轮提问：词条检索、文档检索、触发增强三处都用它 */
  text: string;
  /** 归属用户 id：长期画像**按人隔离**（契约 docs/TENANCY-SPEC.md §7）。缺省 null＝本地单人模式 */
  ownerId?: string | null;
}

export interface CollectedContext {
  /** 有序清单（空内容的段已剔除） */
  segments: ContextSegment[];
  /** 附加段 + 基础提示词的 token 合计——`truncateHistoryToBudget` 要的就是它 */
  systemPromptTokens: number;
  /** 已剔除被摘要覆盖的部分，可直接进截断 */
  liveHistory: HistoryMessage[];
}

/**
 * 造齐本轮全部附加段，并算好它们占的窗口。
 *
 * 段的**内容构造**留在这里而不是 `flow.ts`：它们各自依赖 `text`/`sessionId`，
 * 与「组装」是同一件事的两面——分开放就又成了双真相源。
 */
export function collectContextSegments(inputs: ContextInputs): CollectedContext {
  const { history, sessionId, text, ownerId } = inputs;

  // 长期记忆（契约 docs/MEMORY-SPEC.md）：摘要段（本会话早前内容的浓缩）+ 画像段
  // （跨会话的学习者事实）+ 已被摘要覆盖的历史。两段都进 system 位、都占窗口。
  const { summaryBlock, memoryBlock, liveHistory } = buildMemoryContext(history, sessionId, ownerId);

  // 忆域 v2（词条库注入）：检索与本次提问相关的已入库词条，软性提示 AI 优先使用；
  // 命中失败/为空不影响对话（ADR-4），词条段短（约 ≤1k tokens）。
  const relevantTerms = getRelevantTerms(text, 15);
  const termLines = relevantTerms.map((t) => `- ${t.term}（${t.domain}）：${t.definition}`).join('\n');
  const termBlock =
    relevantTerms.length > 0
      ? `以下是你的术语记忆库中与本次提问相关的词条，回复时请优先使用这些术语（保持回答自然，不必逐条列举）：\n${termLines}`
      : '';

  // 文档模式（契约 5.0 §5.1.1 + DOC-RAG-SPEC）：短文档整篇直塞（逐字等价旧行为），
  // 长文档拿本轮提问作查询检索 Top-K——传 query 就是这一行的全部改动，预算口径不需动：
  // 下面量的就是最终要上屏的那段字，不管它是全文还是 12 个段落。
  const doc = getSessionDoc(sessionId);
  const docBlock = doc ? buildDocBlock(doc, text) : '';

  const segments: ContextSegment[] = [
    // 日期段（2026-09-17）：模型没有时钟，不喂它就不知道今天几号（问「距考试还有几天」
    // 只能瞎猜）。**恒非空、且一天之内恒定**——刻意不含时分秒，否则每轮 system 都变，
    // prompt 前缀缓存永远不命中。它与基础提示词同属「这次对话的前提」，故排在最前。
    { kind: 'date', content: buildDateBlock() },
    { kind: 'summary', content: summaryBlock },
    { kind: 'terms', content: termBlock },
    { kind: 'doc', content: docBlock },
    // 表达偏好段（契约 ANSWER-STYLE §3）：四维全默认时它只是重述现状口径、不改口吻。
    // 它**恒非空**（至少含 scope 那句），故无需条件判断——空内容段会在下面被统一剔除。
    { kind: 'style', content: buildAnswerStyleBlock(loadAnswerStyle()) },
    { kind: 'memory', content: memoryBlock },
    // 触发增强（2026-09-14 方案选择框 / 2026-09-17 联网搜索）：识别「这条提问是不是在做选择/规划
    // 或要求联网检索」，命中则追加硬指令。两者同时命中时 **search 优先**——学习者明说"搜一下"
    // 是**动作指令**不是岔路，而实测里模型偏偏在这时弹了 ask_choice 让他先拍板（bug-ledger B-006），
    // 故不给它"先问再搜"的机会（理由详见 `search-nudge.ts` 文件头「与 choice-nudge 的差异」）。
    { kind: 'nudge', content: searchNudge(text) ?? choiceNudge(text) ?? '' },
  ];

  // 空段统一剔除：预算与组装看到的是**同一份**清单，不可能一边算一边不算
  const kept = segments.filter((s) => s.content !== '');
  return {
    segments: kept,
    systemPromptTokens: countSegmentTokens(kept) + estimateTokens(SYSTEM_PROMPT),
    liveHistory,
  };
}

/** 附加段占的窗口合计（不含基础提示词）。 */
export function countSegmentTokens(segments: ContextSegment[]): number {
  return segments.reduce((sum, seg) => sum + estimateTokens(seg.content), 0);
}

/**
 * 按清单顺序装配出站消息。
 *
 * `history` 是**已截断**的历史（调用方先拿 `systemPromptTokens` 去 `truncateHistoryToBudget`），
 * 因为截断本身依赖本函数产出的段清单——顺序不能颠倒。
 *
 * @returns `messages` 出站数组；`nudgeMsg` 触发增强那条消息的**引用**，
 *          首轮结束后由调用方 `indexOf` + `splice` 摘除（未命中为 null）。
 */
export function assembleContextMessages(
  segments: ContextSegment[],
  history: ChatMessage[],
): { messages: ChatMessage[]; nudgeMsg: ChatMessage | null } {
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  let nudgeMsg: ChatMessage | null = null;
  let headCount = 0;
  for (const seg of segments) {
    if (!seg.content) continue;
    const msg: ChatMessage = { role: 'system', content: seg.content };
    if (HEAD_KINDS.has(seg.kind)) {
      // 头部段按清单顺序插在基础提示词之后、历史之前。用递增下标而不是恒插 1：
      // 将来若多一个头部段，恒插 1 会让它们**倒序**（后插的挤到前面）。
      messages.splice(1 + headCount, 0, msg);
      headCount += 1;
    } else {
      messages.push(msg);
    }
    if (REMOVABLE_KINDS.has(seg.kind)) nudgeMsg = msg;
  }
  return { messages, nudgeMsg };
}
