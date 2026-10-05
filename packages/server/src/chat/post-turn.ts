/**
 * chat/post-turn —— 一轮回复**跑完之后**做的事（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §5.4）。
 *
 * 三件事，**顺序不可换**：
 *   ① 抽词（`runTermExtraction`，经 AI 网关）→ ② 落词条库（`saveTerms`）→ ③ 长期记忆压缩（`compactIfNeeded`）。
 *
 * ★ 为什么从 `chat/flow.ts` 搬出来：那个文件收尾时 394 行，就地加这一步会顶到 server
 *   `≤400` 红线。`flow.ts` 管「这一轮**怎么跑**」，本文件管「跑完了**收什么尾**」。
 * ★ 为什么 ② 排在 ③ 之前：压缩要打一次 LLM（配额有限），产物收口必须先做完。
 *
 * ★ 2026-09-29 改走**持久化后台任务**（`jobs/`，任务种类 `chat.post_turn`）：
 *   改前是 `void promise`——上游抖一下这一轮的词条就永远丢了，进程重启时在途的也一起蒸发。
 *   现在：抽词超时 / 上游报错 / 输出坏了 ⇒ 抛错交给队列按退避重试（最多 3 次）；
 *   没配模型 ⇒ `PermanentJobError`（重试也没用，不白记三行失败账）。
 *   仍然**不 await、不把错误带回对话**：用户此刻已经拿到完整回答了（ADR-4 失败隔离）。
 */
import { saveTerms, runTermExtraction } from '../learning/terms.js';
import { dispatchJob, PermanentJobError, registerJobHandler } from '../jobs/worker.js';
import { compactIfNeeded } from './compact.js';

/** 送去抽词的正文上限（沿用 flow.ts 原有的 30000，避免长回答把这次调用的成本拉爆） */
export const POST_TURN_TEXT_MAX = 30_000;

export const POST_TURN_JOB = 'chat.post_turn';

interface PostTurnPayload {
  sessionId: string;
  material: string;
  /**
   * 本轮真正读过／精选／引用到的网页（v55 词条来源）。可选：
   * 任务会落队列，**改前入队、改后消费**的旧任务没这个字段 ⇒ 缺字段是正常态，不是坏数据。
   */
  sourceUrls?: string[];
}

/** 任务处理函数（导出给测试） */
export async function runPostTurn(payload: unknown, ownerId: string | null): Promise<void> {
  const { sessionId, material, sourceUrls = [] } = payload as PostTurnPayload;
  try {
    const r = await runTermExtraction(material, ownerId);
    if (r.ok) {
      if (r.items.length > 0) saveTerms(r.items, sessionId, ownerId, sourceUrls.length > 0 ? { urls: sourceUrls, origin: 'chat' } : undefined);
    } else if (r.reason === 'no-model') {
      throw new PermanentJobError(r.error);
    } else {
      throw new Error(`抽词失败（${r.reason}）：${r.error}`);
    }
  } finally {
    // 与改前 `.finally` 同口径：抽词无论成败都要压缩（压缩是**下一轮**才生效的，漏不得）；
    // 重试时会再跑一次，`compactIfNeeded` 自带在途去重与阈值判断，多跑只是空转。
    void compactIfNeeded(sessionId, ownerId);
  }
}

registerJobHandler(POST_TURN_JOB, '对话后抽词与记忆压缩', (payload, ctx) => runPostTurn(payload, ctx.ownerId));

export function afterTurn(input: {
  sessionId: string;
  /** 用户这一轮的提问（不含看图蒸馏出来的描述——那部分在 flow 里已并进落库文本） */
  text: string;
  /** 模型这一轮的完整回答 */
  answer: string;
  ownerId: string | null;
  /** 本轮资料架收口后留下的网页地址（服务端事实，不是模型给的） */
  sourceUrls?: string[];
}): void {
  const { sessionId, text, answer, ownerId, sourceUrls = [] } = input;
  dispatchJob({
    kind: POST_TURN_JOB,
    ownerId,
    payload: { sessionId, material: `${text}\n\n${answer}`.slice(0, POST_TURN_TEXT_MAX), sourceUrls } satisfies PostTurnPayload,
  });
}
