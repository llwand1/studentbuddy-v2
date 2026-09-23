/**
 * chat-blocks —— 聊天流内容块的**分派与还原**（纯函数层，契约 docs/SCENARIO-SPEC.md §8 M3）。
 *
 * 职责两条：① live：SSE block 事件 → 消息卡片（quiz 是既有动线、scenario 是 M3 新增）；
 * ② 历史：assistant 行 content 里的 `[QUIZ]{…}[/QUIZ]` / `[SCENARIO]{…}[/SCENARIO]` 登记文本 → 还原成卡片消息
 * （重开会话不丢卡片。★ scenario 从第一天生效，quiz 到 2026-09-23「出题工具化」批才补上——
 *   补的原因就写在 `restoreQuizBlock` 的注释里：模型能在对话里出题之后，丢卡从偶发变成常态）。
 *
 * 为什么单开一文件：useChatStream 贴着 398/400 行红线装不下分派逻辑；把 quiz 的分派一并
 * 挪过来既救了行数，又让「一个 block 事件怎么变成消息」只有一个事实源。
 * 消息视图类型（QuizBlockView / ScenarioBlockView）也定义在这里——useChatStream 与
 * history-fold 双向引用它，放 useChatStream 会成环。
 */
import type { ScenarioPayload } from '@sb/shared';

/** 流内 quiz 卡片的消息挂载形状（live 与历史同构） */
export interface QuizBlockView {
  blockId: string;
  quiz: { title?: string; questions: import('@sb/shared').QuizQuestion[] };
  quizId?: string;
}

/** 流内情景题卡片的消息挂载形状：开宿主面板要 quizId + demoId + 评分点清单三样 */
export interface ScenarioBlockView {
  blockId: string;
  demoId: string;
  quizId?: string;
  payload: ScenarioPayload;
}

/** 纯净 ScenarioPayload 的最小形状校验（历史上没过闸门的数据不能炸消息流） */
function isScenarioPayload(v: unknown): v is ScenarioPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as { title?: unknown; tasks?: unknown };
  if (typeof p.title !== 'string' || !Array.isArray(p.tasks) || p.tasks.length === 0) return false;
  // 评分点至少要 id + criteria.kind 成对可判——演示残骸不算可玩卡片
  return p.tasks.every((t) => {
    const task = t as { id?: unknown; criteria?: { kind?: unknown } };
    return typeof task?.id === 'string' && typeof task?.criteria?.kind === 'string';
  });
}

/**
 * live 分派：把一枚 block 事件变成消息（quiz → QuizCard、scenario → ScenarioPanel）。
 * 认不出的 kind 静默忽略——块协议允许渲染器滞后登记（content-blocks.ts 头注同口径）。
 * 挂载形状与 useChatStream 既有 quiz 分支逐字同构（挪过来不改行为）。
 * 泛型 T 由调用点绑定到 StreamMessage；字面量经 unknown 双转型是刻意的——
 * 这里的「消息最小形状」是分派层的事实源，完整消息类型在 useChatStream（反向引用会成环）。
 */
export function applyChatBlock<T>(
  setMessages: (updater: (ms: T[]) => T[]) => void,
  blockId: string,
  payload: unknown,
): void {
  const p = payload as { kind?: string; payload?: unknown } | undefined;
  if (!p) return;
  if (p.kind === 'quiz' && p.payload) {
    const quiz = p.payload as QuizBlockView['quiz'];
    const quizIdMatch = blockId.match(/quiz-(.+)/);
    setMessages((ms) => [
      ...ms,
      { role: 'assistant', content: '', quizBlock: { blockId, quiz, quizId: quizIdMatch?.[1] } } as unknown as T,
    ]);
    return;
  }
  if (p.kind === 'scenario' && p.payload) {
    const view = openScenarioView(blockId, p.payload);
    if (view) setMessages((ms) => [...ms, { role: 'assistant', content: '', scenarioBlock: view } as unknown as T]);
  }
}

/**
 * 历史还原：assistant 行 content 里的 `[QUIZ]{…}[/QUIZ]` → 题卡视图（2026-09-23 出题工具化批补）。
 * ★ 这一步 quiz 比 scenario 晚了一个功能周期：本文件头注原先就自认「quiz 块历史上没做这一步」。
 *   出题只有 REST 一条入口时，丢卡要人主动点「出题」才看得见；聊天模型能自己出题之后，
 *   「AI 刚出的题、重开会话只剩一坨 JSON」会变成常态，所以补齐。
 * ★ `quizId` 从登记行顶层键读回来（与 `[SCENARIO]` 同构）：没有它卡片答完不写 `quiz_stats`，
 *   而 live 那条是从 `blockId` 反解的、历史拿不到 ⇒ 老行没这键就还原成「只看不记账」的卡（不炸流）。
 */
export function restoreQuizBlock(content: string): QuizBlockView | null {
  const body = content.match(/\[QUIZ\]([\s\S]*?)\[\/QUIZ\]/)?.[1];
  if (!body) return null;
  try {
    const o = JSON.parse(body) as { title?: unknown; questions?: unknown; quizId?: unknown };
    if (!Array.isArray(o.questions) || o.questions.length === 0) return null;
    const quizId = typeof o.quizId === 'string' && o.quizId ? o.quizId : undefined;
    return {
      blockId: `quiz-${quizId ?? 'legacy'}`,
      quiz: {
        ...(typeof o.title === 'string' ? { title: o.title } : {}),
        questions: o.questions as QuizBlockView['quiz']['questions'],
      },
      ...(quizId ? { quizId } : {}),
    };
  } catch {
    return null;
  }
}

/** blockId `scenario-<demoId>` → 视图；payload 形状不对 / demoId 抽不出 ⇒ null（不开坏卡） */
export function openScenarioView(blockId: string, payload: unknown): ScenarioBlockView | null {
  if (!isScenarioPayload(payload)) return null;
  const demoId = blockId.match(/^scenario-(.+)$/)?.[1];
  if (!demoId) return null;
  return { blockId, demoId, payload };
}

/**
 * 历史还原：assistant 行 content 里的 `[SCENARIO]{…}[/SCENARIO]` → 卡片视图。
 * 登记文本由 routes/scenario.ts generate（sessionId 分支）写入：payload 顶层 + quizId/demoId
 * 两个登记键（登记键只进聊天消息 content，quiz_bank data 保持纯契约形状）。
 * 缺 demoId / 形状坏 ⇒ null——该行回落普通文本展示，不让一行旧数据毁掉整个会话的加载。
 */
export function restoreScenarioBlock(content: string): ScenarioBlockView | null {
  const body = content.match(/\[SCENARIO\]([\s\S]*?)\[\/SCENARIO\]/)?.[1];
  if (!body) return null;
  try {
    const o = JSON.parse(body) as ScenarioPayload & { quizId?: unknown; demoId?: unknown };
    if (!isScenarioPayload(o)) return null;
    if (typeof o.demoId !== 'string' || !o.demoId) return null;
    return {
      blockId: `scenario-${o.demoId}`,
      demoId: o.demoId,
      quizId: typeof o.quizId === 'string' ? o.quizId : undefined,
      payload: { title: o.title, tasks: o.tasks },
    };
  } catch {
    return null;
  }
}
