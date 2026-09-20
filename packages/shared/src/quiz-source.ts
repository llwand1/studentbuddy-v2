/**
 * 出题**来源**配比——真题（契约 `docs/QUIZ-BLEND-SPEC.md` §3.1；2026-09-20 老板点单）。
 *
 * ★ 为什么单独一个文件：本仓 **shared 单文件同样受 400 行红线**（AGENTS.md「行数红线」，
 *   与 `study-flow-params.ts` 从 `server/.../flow-registry.ts` 上提时的判据同源）。
 *   `content-blocks.ts` 加完本区块后到 426 行触线 ⇒ 按仓规**拆文件、不压注释**。
 * ★ 依赖方向**单向**：本文件从 `content-blocks.ts` 取 `MIX_KINDS` / `MAX_QUIZ_TOTAL` /
 *   `mixTotal` 与 `QuizMix` / `QuizMixKind` 类型；反向只有 `content-blocks.ts` 对
 *   `QuizSourceMix` 的 **type-only** import（编译期擦除）⇒ 运行时**不构成环**。
 */

import { MIX_KINDS, MAX_QUIZ_TOTAL, mixTotal } from './content-blocks.js';
import type { CollectReport, QuizMix, QuizMixKind, QuizMixReport } from './content-blocks.js';

// ── 合流报告（契约 docs/QUIZ-BLEND-SPEC.md §3.4）──
//
// ★ 为什么类型住在 shared 而不是服务端的 `learning/quiz-blend.ts`：它是**前后端契约**
//   ——服务端填、前端念（`mix-report.ts` 的 `blendNote` 逐字段读它）。类型放服务端，
//   前端就只能自己抄一份，这正是本仓「前后端类型双写漂移」要根治的老毛病
//   （见 `shared/src/index.ts` 头注的单一事实源原则）。

/** 逐题型缺口项：前端直接念 `label`，不自己拼文案（题型名的单点来源是 `MIX_KIND_LABELS`） */
export interface BlendMissing {
  type: QuizMixKind;
  /** 用户要了几道 */
  want: number;
  /** 实际摘到几道 */
  got: number;
  /** 题型中文名 */
  label: string;
}

/** 合流结果报告：AI 侧沿用既有 `QuizMixReport`，真题侧与搜集记录各自如实回执（ADR-5 不静默） */
export interface QuizBlendReport {
  ai: QuizMixReport;
  real: {
    requested: QuizSourceMix;
    actual: QuizSourceMix;
    /** 只列没摘够的档；空数组＝全部摘够（或本次没配真题） */
    missing: BlendMissing[];
  };
  /** 逐页抓取与逐题拒绝的原始记录；本次没配真题时省略 */
  collect?: CollectReport;
}

// ── 出题来源配比：真题（契约 docs/QUIZ-BLEND-SPEC.md §3.1；2026-09-20 老板点单）──
//
// ★ 为什么是「两个平行结构 + 联合钳位」而不是把 QuizMix 改成 `{ai, real}` 二维对象：
//   改结构会同时打穿 normalizeQuizMix / stepQuizMix / setQuizMix / applyQuizMix / 设置页卡
//   与全部既有测试，而本仓「纯加法」纪律要求旧调用点零改动。故 AI 侧沿用 `QuizMix`，
//   真题侧平级新增 `QuizSourceMix`，两侧靠下面的联合钳位函数保证「合起来 ≤ 20」。

/** 落 app_settings 的键名（server 读写，前端不直接碰库；与 `quiz_mix` 并列） */
export const SETTING_KEY_QUIZ_SOURCE_MIX = 'quiz_source_mix';

/**
 * 每题型的**真题**道数（键与 `QuizMix` 同族）。
 * `scenario` 恒 0：情景题是一套可玩交互 demo，网页上不存在可逐字摘录的同类物（契约 §5 E1）。
 */
export type QuizSourceMix = Record<QuizMixKind, number>;

/** 默认全 0＝不出真题：老用户升级后行为零变化（纯加法原则） */
export const DEFAULT_QUIZ_SOURCE_MIX: QuizSourceMix = {
  single: 0,
  multiple: 0,
  fill: 0,
  essay: 0,
  judge: 0,
  scenario: 0,
};

/**
 * 单题型真题上限 **5**（AI 侧是 10）：网上同题型的可用题本就有限，
 * 且搜集管道单次摘题上限只有 10 道（`MAX_COLLECT_QUESTIONS`）——配再多也摘不回来。
 */
export const MAX_QUIZ_REAL_PER_TYPE = 5;

/**
 * 真题侧单档上限按档取：情景题/判断题 0，其余 5。与 `mixKindCap` 同族。
 * ★ judge 恒 0（PK-SPEC §15 B2）：判断题网上规范格式稀少（多为交互式小部件，摘不出
 *   verbatim 锚点），且 AI 零成本就能出——摘录无增益，反给搜集管道添一类校验分支。
 *   判断题只走 AI 侧（设置页 AI 配比 / 对战出题现选）。
 */
export function sourceKindCap(kind: QuizMixKind): number {
  return kind === 'scenario' || kind === 'judge' ? 0 : MAX_QUIZ_REAL_PER_TYPE;
}

/** 真题侧总题数（与 `mixTotal` 同实现；结构形状相同但语义不同，故各留一个入口不互相顶替） */
export function sourceMixTotal(mix: QuizSourceMix): number {
  return MIX_KINDS.reduce((sum, t) => sum + mix[t], 0);
}

/** AI 题 + 真题的合计（设置页「共 N / 20 题（其中真题 M 题）」用） */
export function blendTotal(ai: QuizMix, real: QuizSourceMix): number {
  return mixTotal(ai) + sourceMixTotal(real);
}

/**
 * 真题配比归一化（**联合钳位**，契约 §3.2）：
 * ① 非数字/负数→0，小数取整，单档钳到 `sourceKindCap`（情景题恒 0）；
 * ② 总量（AI 侧 + 真题侧）超 `MAX_QUIZ_TOTAL` 时，**削真题侧**——AI 侧优先保额。
 *
 * ★ 为什么 AI 优先保额：AI 出题是**必定成功**的路径（模型配好就能出题），真题是**尽力而为**
 *   的路径（摘不到就报缺）。若让真题先占额，会频繁出现「真题没摘到、AI 额度也被挤掉」的双输
 *   ——用户配的题数凭空消失。
 * ★ 与 `normalizeQuizMix` 的一处刻意不同：**真题侧全 0 是最常见配置（＝不出真题），绝不回退默认**；
 *   后者的「全 0 回退默认」针对的是「一套 0 题的题组没有意义」，两者前提不同。
 */
export function normalizeQuizSourceMix(input: unknown, aiMix: QuizMix): QuizSourceMix {
  const src = (input ?? {}) as Partial<Record<QuizMixKind, unknown>>;
  const out: QuizSourceMix = { ...DEFAULT_QUIZ_SOURCE_MIX };
  for (const t of MIX_KINDS) {
    const n = Number(src[t]);
    out[t] = Number.isFinite(n) ? Math.min(sourceKindCap(t), Math.max(0, Math.trunc(n))) : 0;
  }
  // 超总量从后往前削真题（倒档位序＝先砍情景、再砍解答…），削到不超为止
  let over = blendTotal(aiMix, out) - MAX_QUIZ_TOTAL;
  for (let i = MIX_KINDS.length - 1; i >= 0 && over > 0; i--) {
    const t = MIX_KINDS[i];
    if (!t) continue;
    const cut = Math.min(out[t], over);
    out[t] -= cut;
    over -= cut;
  }
  return out;
}

/**
 * 编辑态单步调整真题（设置页「网络真题」列的 + 按钮用）：
 * 加档同时受「真题单档上限」与「AI 侧 + 真题侧 ≤ MAX_QUIZ_TOTAL」两道约束。
 * 与 `stepQuizMix` 同族：编辑期就钳住，绝不悄悄动别的档位。返回新对象，不改入参。
 */
export function stepQuizSourceMix(real: QuizSourceMix, ai: QuizMix, type: QuizMixKind, delta: number): QuizSourceMix {
  if (delta === 0) return { ...real };
  if (delta < 0) return { ...real, [type]: Math.max(0, real[type] + delta) };
  const step = Math.min(delta, sourceKindCap(type) - real[type], MAX_QUIZ_TOTAL - blendTotal(ai, real));
  return { ...real, [type]: real[type] + Math.max(0, step) };
}

/**
 * 编辑态直输真题（设置页「网络真题」列的输入框用）：把某档直接设为指定值。
 * 约束与 `stepQuizSourceMix` 同源——单档 [0, sourceKindCap]；总分 ≤ 20：
 * 若输入值会顶破总上限，只给到「AI 侧与其他真题档占用后剩余的额度」，不牵连别的档位。
 */
export function setQuizSourceMix(real: QuizSourceMix, ai: QuizMix, type: QuizMixKind, value: number): QuizSourceMix {
  const room = MAX_QUIZ_TOTAL - mixTotal(ai) - (sourceMixTotal(real) - real[type]);
  const cap = Math.min(sourceKindCap(type), room);
  const v = Number.isFinite(value) ? Math.trunc(value) : 0;
  return { ...real, [type]: Math.min(Math.max(0, v), Math.max(0, cap)) };
}
