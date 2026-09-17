/**
 * 薄弱点分析契约（契约 `docs/QUIZ-WEAK-SPEC.md`）—— **前后端唯一事实源**。
 *
 * 为什么放进 shared：`WeakPoint` 此前只在 server 的 `learning/quiz.ts` 里定义，前端
 * `QuizBankPage.tsx` 手抄了一份结构等价的内联字面量（`Array<{topic, questionIndexes, reason, suggestion}>`）。
 * 加一个字段就要改两处，漏一处就是「后端发了新字段、前端不认」的静默降级——与
 * `TaskItem` 曾有三份定义同源的老病（见 `task-list.ts` 头注）。
 *
 * 语义要点（2026-09-15 改判）：
 * - 分析由 `analyzer` 角色模型**实时生成**：按错题聚类出若干「薄弱主题」，每条给
 *   具体错因与针对性建议。此前是纯本地规则产出的两句固定文案
 *   （`reason: '正确率低于 60% 的题目'` / `suggestion: '针对这些题重新练习，并阅读解析'`），
 *   而 `analyzer` 角色虽早在 `llm/router.ts` 注册、设置页可绑定，却从无代码调用——纯空转。
 * - 模型未配置或调用失败时**降级为本地规则版**（ADR-4 失败不崩），但必须由 `fallback`
 *   + `failure` 如实标注。前端不得把降级结果冒充成 AI 分析（ADR-5 报错说真话）——
 *   用户为此去设置页绑模型才是正解，装作分析成功等于让他永远调不到点子上。
 */

/** 一条薄弱点：一个「薄弱主题」下聚了一组错题，带错因与建议 */
export interface WeakPoint {
  /** 薄弱主题名（如「定积分换元法」），由模型**从题干聚类**得出，不是题库标题 */
  topic: string;
  /** 该主题下的题目下标（0 基；前端展示时 +1） */
  questionIndexes: number[];
  /** 具体错因：说清错在哪一步，不是「正确率低」这类把数据复述一遍 */
  reason: string;
  /** 针对性建议 */
  suggestion: string;
}

/**
 * 降级真因（ADR-5：谁真知道原因谁填，调用方**不反推**）。
 * - `no-model`：`analyzer` 角色没绑模型或没有启用的服务商 → 应引导去设置页
 * - `call-failed`：模型调用抛错（网络/鉴权/超时）→ 可重试
 * - `parse`：模型有输出但不成结构（弱模型给散文是常态）→ 可重试，与上一条是两条路
 */
export type WeakFailure = 'no-model' | 'call-failed' | 'parse';

/** 一次分析的完整结果 */
export interface WeakAnalysis {
  /** 薄弱主题列表；空数组 = 没有可分析的内容（见 `analyzed`） */
  weak: WeakPoint[];
  /** true = 本次是本地规则版，前端必须如实标注，不得渲染成 AI 分析 */
  fallback: boolean;
  /** 仅 `fallback === true` 时有值 */
  failure?: WeakFailure;
  /**
   * 本次参与分析的错题数。**0 = 还没做题**，属正常空态（不是降级）——
   * 与「模型挂了所以退回规则版」是两件事，前端文案必须分开说。
   */
  analyzed: number;
}

/**
 * 最多聚类几个薄弱主题。超过 4 个说明模型在硬凑——用户一次抓不住 6 个重点，
 * 那等于没有重点。
 */
export const WEAK_MAX_POINTS = 4;

/**
 * 各字段长度上限。既是**服务端校验闸**（防模型灌大 payload），
 * 也是**前端展示口径**——两侧引用同一个数，不会出现「后端截了前端又截一次」。
 */
export const WEAK_TOPIC_MAX = 40;
export const WEAK_REASON_MAX = 200;
export const WEAK_SUGGESTION_MAX = 300;

/** 模型输出的原始条目形状：弱模型可能缺字段/给错类型，一律按 `unknown` 收，不信任何字段 */
interface RawWeakPoint {
  topic?: unknown;
  questionIndexes?: unknown;
  reason?: unknown;
  suggestion?: unknown;
}

/** 取一个裁剪过的非空字符串；非字符串/空白/超长一律按契约归一 */
function text(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

/**
 * 归一题号：只收 `0..questionCount-1` 的整数，并剔除已被前面主题占用的题。
 * 返回升序数组（用户看到的题号顺序应与题目顺序一致，不该跟模型的书写顺序走）。
 */
function indexes(raw: unknown, questionCount: number, used: Set<number>): number[] {
  if (!Array.isArray(raw)) return [];
  const list: unknown[] = raw;
  const out: number[] = [];
  for (const v of list) {
    if (typeof v !== 'number' || !Number.isInteger(v)) continue;
    if (v < 0 || v >= questionCount || used.has(v) || out.includes(v)) continue;
    out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 归一模型输出的薄弱点数组——**模型输出一律不可信**，本函数是唯一闸门。
 *
 * 三道丢弃规则（宁可少给一条，也不要给一条用户无法照做的）：
 * 1. `topic` / `reason` / `suggestion` 三者缺一即丢——半成品条目在屏上就是一句空话；
 * 2. 过滤越界/非整数题号后**一条不剩**即丢——题号是这套分析唯一能落地的锚点，
 *    不指向任何题的「薄弱点」用户看完不知道去练哪几道；
 * 3. 跨条目去重——聚类是对错题的**划分**，一道题归进两个主题等于把划分作废。
 *
 * 全部条目非法时返回 `[]`，调用方据此判 `parse` 失败并降级，而不是拿半成品糊弄用户。
 *
 * @param raw 模型解析出的原始值（任意形状）
 * @param questionCount 本套题总题数，用于越界判定
 */
export function normalizeWeakPoints(raw: unknown, questionCount: number): WeakPoint[] {
  if (!Array.isArray(raw)) return [];
  const list: unknown[] = raw;
  const used = new Set<number>();
  const out: WeakPoint[] = [];
  for (const item of list) {
    if (out.length >= WEAK_MAX_POINTS) break;
    const p = item as RawWeakPoint;
    const topic = text(p.topic, WEAK_TOPIC_MAX);
    const reason = text(p.reason, WEAK_REASON_MAX);
    const suggestion = text(p.suggestion, WEAK_SUGGESTION_MAX);
    if (!topic || !reason || !suggestion) continue;
    const idx = indexes(p.questionIndexes, questionCount, used);
    if (idx.length === 0) continue;
    for (const i of idx) used.add(i);
    out.push({ topic, questionIndexes: idx, reason, suggestion });
  }
  return out;
}
