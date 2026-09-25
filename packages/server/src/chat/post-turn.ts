/**
 * chat/post-turn —— 一轮回复**跑完之后**做的事（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §5.4）。
 *
 * 三件事，**顺序不可换**：
 *   ① 抽词（`extractTerms`，一次 LLM 调用）→ ② 落词条库（`saveTerms`）→ ③ 长期记忆压缩（`compactIfNeeded`）。
 *
 * ★ 为什么从 `chat/flow.ts` 搬出来：那个文件收尾时 394 行，就地加这一步会顶到 server
 *   `≤400` 红线。按仓规**拆文件、不压注释**。接缝本身就干净：
 *   `flow.ts` 管「这一轮**怎么跑**」（锁 / 流 / 工具循环 / 落库），本文件管「跑完了**收什么尾**」。
 *   两者的读者也不同——前者要**改对话行为**时读，后者要**改学习产物**时读。
 *
 * ★ 为什么 ② 排在 ③ 之前：压缩要打一次 LLM（配额有限），产物收口必须先做完（同原有注释的取舍）。
 *
 * ★ 2026-09-25：原第③步「追问会话连星型边」（`linkFollowUpEdges`，写 knowledge_edge）随
 *   「学习流＋知识图」功能整体下线删除（批次 K）——每轮白写一张没人读的表，正是删它的理由。
 *
 * ★ 全链路**一条都不 await、也一条都不上报错误**：用户此刻已经拿到完整回答了，
 *   这个过程态失败只该静默降级（ADR-4 失败隔离），绝不能把已上屏的回答变出错。
 *   `.finally` 保证压缩无论如何都会跑（它是**下一轮**才生效的，这一轮绝不能把它漏掉）。
 */
import { saveTerms, extractTerms } from '../learning/terms.js';
import { compactIfNeeded } from './compact.js';

/** 送去抽词的正文上限（沿用 flow.ts 原有的 30000，避免长回答把这次调用的成本拉爆） */
export const POST_TURN_TEXT_MAX = 30_000;

export function afterTurn(input: {
  sessionId: string;
  /** 用户这一轮的提问（不含看图蒸馏出来的描述——那部分在 flow 里已并进落库文本） */
  text: string;
  /** 模型这一轮的完整回答 */
  answer: string;
  ownerId: string | null;
}): void {
  const { sessionId, text, answer, ownerId } = input;
  void extractTerms(`${text}\n\n${answer}`.slice(0, POST_TURN_TEXT_MAX), ownerId)
    .then((items) => {
      if (items.length > 0) saveTerms(items, sessionId, ownerId);
    })
    .catch(() => undefined) // 抽词/落库失败：静默降级，对话已经结束了
    .finally(() => {
      void compactIfNeeded(sessionId, ownerId);
    });
}
