/**
 * learning/flow-registry — 学习流**步骤注册表**（纯逻辑，零 IO，可直测）。
 *
 * 职责边界：把「一种学习交互体验」（`FlowStepKind`）映射到**执行器**，并构造脚本化提问。
 * 不碰 DB、不碰 LLM、不碰 HTTP（薄层原则 ADR-3 的服务端半边）。
 *
 * ★ 与 shared 的分工（2026-09-17 前端批次调整过一次，**以本段为准**）：
 *   · `shared/study-flow.ts` 的 `FLOW_STEP_METAS` = **元信息**（label/params/produces/awaitsUser）。
 *   · `shared/study-flow-params.ts` = **参数校验**（`validateStepParams`）。
 *     ★ 校验原在本文件，前端做参数表单时必须「提交前先校验」，若前端另写一份就必然口径漂移
 *     ⇒ 上提到 shared 做成前后端唯一一份；本文件只 **re-export** 以保持既有调用方零改动。
 *   · 本文件 = **服务端独有行为**（executor 注册 + 提示词构造），前端不需要 ⇒ 留在 server。
 *   三者由 `kind` 对齐；新增一种步骤 = shared 加元信息 + 本文件注册一个 executor。
 *
 * ★ 为什么「未注册 executor」不是静默跳过：跳过会让用户以为这一步跑了、其实没跑，
 *   而产出的知识数据也随之缺失——出错必须让运行**失败并说清是哪一种类型没接**（ADR-5 不静默）。
 *   待接清单见契约 docs/STUDY-FLOW-SPEC.md §7。
 */
import type { FlowPort, FlowStepKind } from '@sb/shared';

// 参数校验已上提到 shared（前后端同源，理由见上方头注释）——此处转出，既有
// `import { validateStepParams } from './flow-registry.js'` 调用方零改动。
export { validateStepParams } from '@sb/shared';
export type { ParamCheck } from '@sb/shared';


// ── 提示词构造（步骤 → 一句脚本化提问）──
//
// ★ 设计要点：每一步的「执行」不是另起一套 LLM 调用，而是**该会话里的一句脚本化提问**，
//   交给既有单轮编排（`chat/flow.ts` 的 handleMessage）去跑——工具循环、联网检索、词条抽取、
//   消息落库全都不必重写。这正是「控制流按用户规定的方式产出知识数据」的落地形态：
//   控制流规定的就是**说什么、按什么顺序说**，产出则完全复用既有的知识沉淀管线。
//   ⇒ 引擎零新增 LLM 调用路径，也就不存在「第二套提示词与主流程漂移」的老毛病。

export interface StepPrompt {
  /** 作为该会话新一轮提问发出的文本 */
  text: string;
  /** 跑完这一步是否要停下来等用户交互（默认取注册表 `awaitsUser`） */
  awaitUser: boolean;
  /** 停等时给前端的说明（用户要知道「在等什么」） */
  pauseReason: string | null;
}

/** 把某一步翻译成发给模型的脚本化提问（纯函数；params 必须先过 validateStepParams） */
export function buildStepPrompt(kind: FlowStepKind, params: Record<string, unknown>): StepPrompt {
  const s = (k: string, d = ''): string => (typeof params[k] === 'string' ? (params[k] as string) : d);
  const n = (k: string, d: number): number => (typeof params[k] === 'number' ? (params[k] as number) : d);
  const b = (k: string, d = false): boolean => (typeof params[k] === 'boolean' ? (params[k] as boolean) : d);

  switch (kind) {
    case 'explain': {
      const depth = { brief: '简明说清要点即可', normal: '常规深度', deep: '要含推导过程与反例' }[s('depth', 'normal')];
      return {
        text: `请讲解「${s('topic')}」，${depth ?? '常规深度'}${b('withExample', true) ? '，并给一个具体例子' : ''}。`,
        awaitUser: false,
        pauseReason: null,
      };
    }
    case 'quiz':
      return {
        text:
          `就「${s('topic')}」给我出 ${n('count', 3)} 道题` +
          `${b('online', true) ? '，可以联网找素材保证题目准确' : '，不需要联网'}。`,
        awaitUser: true,
        pauseReason: '题目已生成，请先作答；答完点「继续」进入下一步',
      };
    case 'scenario':
      // ★ 情景演练不走脚本化提问：聊天模型吐不出可靠的 demo（评分点接不上桥接是常态），
      //   由 flow-executors.ts 的专用执行器 scenarioStep 直接调 generateScenario（SCENARIO-SPEC §8 M4）。
      //   翻译表缺这一支会在编译期暴露——这是刻意的穷尽性哨兵，不是遗漏。
      throw new Error('scenario 步骤由专用执行器执行（generateScenario），不走脚本化提问');
    case 'grade':
      return {
        text: `请对上面这套题的作答判分，逐题说明错因${b('strict', false) ? '（严格口径：表述不严谨也算错）' : ''}。`,
        awaitUser: false,
        pauseReason: null,
      };
    case 'review': {
      const scope = { last: '最近这一套题', weak: '我的薄弱点', all: '我所有的错题' }[s('scope', 'weak')];
      return {
        text: `请复盘我的错题（范围：${scope ?? '我的薄弱点'}，最多 ${n('max', 5)} 题），每题说清我错在哪、正确思路是什么。`,
        awaitUser: false,
        pauseReason: null,
      };
    }
    case 'digest':
      return {
        text: `请把本次学习涉及的内容整理成词条入库（归入领域 ${s('domain', 'general')}，只收重要度高于 ${n('minImportance', 0.4)} 的）。`,
        awaitUser: false,
        pauseReason: null,
      };
    case 'summary': {
      const style = { brief: '一段话讲完', outline: '用提纲分点', detailed: '详细展开' }[s('style', 'outline')];
      return {
        text: `请把本次学过的内容总结一遍（${style ?? '用提纲分点'}）。`,
        awaitUser: false,
        pauseReason: null,
      };
    }
  }
}

// ── 执行器注册表 ──

/** 步骤执行上下文。`upstream` 让后续步骤能引用前面步骤的产出（步骤间传数据） */
export interface FlowStepContext {
  runId: string;
  stepId: string;
  kind: FlowStepKind;
  params: Record<string, unknown>;
  sessionId: string | null;
  /** 该 run 中前面各步的产出摘要，按 stepId 索引 */
  upstream: Record<string, Record<string, unknown>>;
}

export interface FlowStepOutcome {
  /** 落进 `flow_run_step.output` 的产出摘要（JSON 可序列化） */
  output: Record<string, unknown>;
  /** 出口端口（决定走哪条边）；缺省 'next' */
  port?: FlowPort;
  /** 覆盖注册表的 `awaitsUser`（执行器可依运行时情况决定停不停） */
  awaitUser?: boolean;
  pauseReason?: string;
}

export type FlowStepExecutor = (ctx: FlowStepContext) => Promise<FlowStepOutcome>;

/** kind → executor。进程内注册表（同 chat/tools.ts 的 registry 手法） */
const executors = new Map<string, FlowStepExecutor>();

export function registerExecutor(kind: FlowStepKind, fn: FlowStepExecutor): void {
  executors.set(kind, fn);
}

export function getExecutor(kind: string): FlowStepExecutor | undefined {
  return executors.get(kind);
}

/** 已接入执行器的步骤类型（运行器据此如实报错，契约 §7 待接清单同源） */
export function registeredKinds(): string[] {
  return [...executors.keys()];
}

/** 测试辅助：清空注册表（注入 fake 前调用，防跨用例串味） */
export function clearExecutorsForTest(): void {
  executors.clear();
}
