/**
 * choice — 「AI 方案选择框」契约（契约 docs/ASK-CHOICE-SPEC.md）。
 *
 * 定位：把「让学习者拍板」从打字变成点一下。AI 走到决策岔路时调 `ask_choice` 工具，
 * 界面在输入框上方弹出方案卡并**阻塞等待**，用户点选后把结果回灌给模型，**同一轮**接着干活
 * （不新开会话、不重发提问）。
 *
 * 与 ai-orchestrator-v2 的同名能力（`packages/shared/src/choice.ts`）是同一套契约血缘，
 * 差异只有一处：那边是「编排层进程 + opencode 内核插件」两段式，工具靠 HTTP 轮询等答复；
 * 本仓工具与用户答复在**同一个 Node 进程**内，故不需要内部端点与轮询，一个 Promise 就够了。
 * 契约本身（字段/边界/文案口径）保持同源，两边不各写一套。
 *
 * 超时语义（与 orchestrator 一致）：**不设自动超时**，不选就一直等。
 * 代价是会占住会话（`flow.ts` 的同会话串行锁），因此逃生口必须是「事后可恢复」而非事前拦截：
 * 点「停止生成」/ 关会话 / 删会话，任一条都能让挂起的工具立刻解除阻塞。
 */

/** 一个候选方案 */
export interface ChoiceOption {
  /** 稳定 id（回传用；服务端按 o1/o2/o3… 生成，不信任模型传入） */
  id: string;
  label: string;
  /** 一句话说明该方案的取舍（UI 以 dim 色小字呈现） */
  description?: string;
}

/** 提问的生命周期三态 */
export type ChoiceStatus = 'pending' | 'answered' | 'cancelled';

/** 方案选择请求（AI → 用户） */
export interface AskChoiceRequest {
  id: string;
  /** 归属会话：选择题的答案要续进这一轮对话，故必须绑会话 */
  sessionId: string;
  question: string;
  options: ChoiceOption[];
  /** 是否允许「以上都不是，我自己写」的自由输入出口 */
  allowCustom: boolean;
  /** 多选（v1 恒 false，字段预留——UI 与存储已按可多选设计） */
  multi: boolean;
  ts: number;
}

/** 用户答复（用户 → AI） */
export interface AskChoiceReply {
  requestId: string;
  /** 选中的选项 id；走自由输入时为 null */
  optionId: string | null;
  /** 自由输入原文（optionId 为 null 时必有） */
  custom?: string;
  ts: number;
}

/** 落库完整记录（请求 + 当前状态 + 答复）——SSE `choice-asked` 直接下发本结构 */
export interface AskChoiceRecord extends AskChoiceRequest {
  status: ChoiceStatus;
  reply: AskChoiceReply | null;
  answeredAt: number | null;
  /** 作废原因（停止生成 / 会话已删除 / 进程重启），仅 cancelled 时有值 */
  cancelReason?: string;
}

// ---- 边界常量（校验在 shared 做，前端同源引用，避免两侧各写一套魔数） ----

/** 选项数下限：少于 2 个就不叫选择题了 */
export const CHOICE_MIN_OPTIONS = 2;
/** 选项数上限：超过 4 个用户就要开始权衡，违背「降低决策成本」的初衷 */
export const CHOICE_MAX_OPTIONS = 4;
export const CHOICE_QUESTION_MAX = 500;
export const CHOICE_LABEL_MAX = 120;
export const CHOICE_DESC_MAX = 300;
export const CHOICE_CUSTOM_MAX = 1000;

/** 选项 id 生成（o1/o2/o3…）—— 服务端权威，模型传入的 id 一律忽略 */
export const choiceOptionId = (index: number): string => `o${index + 1}`;

/** 把用户答复渲染成给 AI 读的一行文本（工具回灌与「留痕消息」同源，避免措辞漂移） */
export function describeChoiceReply(reply: AskChoiceReply, options: ChoiceOption[]): string {
  if (reply.custom) return `用户自定义答复：${reply.custom}`;
  const hit = options.find((o) => o.id === reply.optionId);
  return hit ? `用户选择：${hit.label}` : '用户已答复（选项已失效）';
}

// ---- 校验与归一（纯函数：服务端落库前调用，测试直接钉边界） ----

export interface ChoiceInputRaw {
  question?: unknown;
  options?: unknown;
  allowCustom?: unknown;
  multi?: unknown;
}

export type ChoiceNormalize =
  | { ok: true; question: string; options: ChoiceOption[]; allowCustom: boolean; multi: boolean }
  | { ok: false; error: string };

/**
 * 归一一份提问入参：非空/条数/长度逐项校验，选项 id 由服务端重排（o1/o2…）。
 * 返回 `{ok:false,error}` 而不是抛异常——调用方（工具）要把错误当作可回灌文本交给模型自纠，
 * 抛出会中断整轮工具循环（契约 §4.2 纠错口径）。
 */
export function normalizeChoiceInput(raw: ChoiceInputRaw): ChoiceNormalize {
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  if (!question) return { ok: false, error: 'question 不能为空' };
  if (question.length > CHOICE_QUESTION_MAX) return { ok: false, error: `question 超长（上限 ${CHOICE_QUESTION_MAX} 字）` };

  const list = Array.isArray(raw.options) ? raw.options : [];
  if (list.length < CHOICE_MIN_OPTIONS) return { ok: false, error: `选项至少 ${CHOICE_MIN_OPTIONS} 个（少于 2 个不叫选择题）` };
  if (list.length > CHOICE_MAX_OPTIONS) return { ok: false, error: `选项最多 ${CHOICE_MAX_OPTIONS} 个（超过用户就要开始权衡，违背降低决策成本的初衷）` };

  const options: ChoiceOption[] = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i] as { label?: unknown; description?: unknown } | null;
    const label = typeof o?.label === 'string' ? o.label.trim() : '';
    if (!label) return { ok: false, error: `第 ${i + 1} 个选项缺 label` };
    if (label.length > CHOICE_LABEL_MAX) return { ok: false, error: `第 ${i + 1} 个选项 label 超长（上限 ${CHOICE_LABEL_MAX} 字）` };
    const desc = typeof o?.description === 'string' ? o.description.trim() : '';
    if (desc.length > CHOICE_DESC_MAX) return { ok: false, error: `第 ${i + 1} 个选项 description 超长（上限 ${CHOICE_DESC_MAX} 字）` };
    options.push({ id: choiceOptionId(i), label, ...(desc ? { description: desc } : {}) });
  }

  return {
    ok: true,
    question,
    options,
    // 自由输入出口默认开 —— 选择题不该把用户的答案框死在自己给的选项里
    allowCustom: typeof raw.allowCustom === 'boolean' ? raw.allowCustom : true,
    multi: typeof raw.multi === 'boolean' ? raw.multi : false,
  };
}

export type ChoiceReplyNormalize =
  | { ok: true; optionId: string | null; custom?: string }
  | { ok: false; error: string };

/** 归一一份答复：optionId 必须属于本条提问，custom 受长度上限约束，至少给一个 */
export function normalizeChoiceReply(
  raw: { optionId?: unknown; custom?: unknown },
  req: { options: ChoiceOption[]; allowCustom: boolean },
): ChoiceReplyNormalize {
  const custom = typeof raw.custom === 'string' ? raw.custom.trim() : '';
  const optionId = typeof raw.optionId === 'string' && raw.optionId ? raw.optionId : null;

  if (!optionId && !custom) return { ok: false, error: 'optionId 与 custom 至少给一个' };
  if (custom && !req.allowCustom) return { ok: false, error: '本条提问未开放自由输入' };
  if (custom.length > CHOICE_CUSTOM_MAX) return { ok: false, error: `自由输入超长（上限 ${CHOICE_CUSTOM_MAX} 字）` };
  if (optionId && !req.options.some((o) => o.id === optionId)) return { ok: false, error: `optionId 不属于本条提问：${optionId}` };

  // 走自由输入时 optionId 归 null：两者互斥，防止下游出现「既选了项又带了自定义」的歧义记录
  return { ok: true, optionId: custom ? null : optionId, ...(custom ? { custom } : {}) };
}
