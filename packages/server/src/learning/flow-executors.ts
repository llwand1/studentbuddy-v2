/**
 * learning/flow-executors — 六种学习交互体验的**默认执行器**（把步骤交给既有单轮编排）。
 * 契约 docs/STUDY-FLOW-SPEC.md §5。
 *
 * ★★ 本文件是整个学习流设计里最省事也最关键的一处（改码前必读）：
 *
 *   每一步的「执行」**不是另起一套 LLM 调用**，而是**该会话里的一句脚本化提问**——
 *   交给既有 `chat/flow.ts` 的 `handleMessage` 去跑。于是：
 *     · 工具循环、联网检索（search_web）、文档 RAG、词条抽取（extractTerms）、
 *       消息落库与思考链回放 —— **一行都不用重写**；
 *     · 引擎**零新增 LLM 调用路径**，也就不存在「学习流有自己的提示词、与主流程逐渐漂移」
 *       这个本仓反复踩过的老毛病（v1 前后端类型双写漂移同款病）；
 *     · 产出**天然就是真实的学习数据**（真的词条进 `term_library`、真的消息进 `messages`），
 *       不是引擎自己编的假记录。
 *
 *   代价值得说清：步骤的产出是**一轮对话**而非一个结构化对象。所以「判分」「错题复盘」
 *   这些步骤的结果落在对话与题库里，`flow_run_step.output` 只存提问原文与那条回答的 id。
 *   要做「步骤产出一张结构化卡片」是下一批的事（契约 §7）。
 *
 * ★ 六种步骤共用**一个** `chatStep`：差异全部由 `buildStepPrompt`（纯函数、可单测）
 *   按 `kind` 翻译。加一种新学习交互 = shared 加一条元信息 + 这里什么都不用改（若它的
 *   执行形态也是「一轮对话」）——这正是「加一种交互不动引擎」的兑现。
 */
import { FLOW_STEP_METAS } from '@sb/shared';
import { buildStepPrompt, registerExecutor } from './flow-registry.js';
import type { FlowStepContext, FlowStepOutcome } from './flow-registry.js';
import { handleMessage } from '../chat/flow.js';
import { announceScenarioToSession, generateScenario } from './scenario.js';
import { emptyScenarioGenReport } from './scenario-protocol.js';

/**
 * 通用步骤执行器：翻译成脚本化提问 → 交既有单轮编排跑完 → 回报产出摘要。
 *
 * ★ 没有会话时**如实抛错**，不静默跳过：学习流的全部价值就是「按你的编排产出学习数据」，
 *   没有会话就没有地方产出，静默跳过会让用户以为这一步跑了。`createRun` 会自动建会话，
 *   所以正常情况下走不到这里；真走到了说明有人手工构造了非法运行实例。
 */
async function chatStep(ctx: FlowStepContext): Promise<FlowStepOutcome> {
  const prompt = buildStepPrompt(ctx.kind, ctx.params);
  if (!ctx.sessionId) {
    throw new Error('该步骤需要一个会话才能执行——创建运行实例时未绑定会话');
  }
  const res = await handleMessage({ sessionId: ctx.sessionId, text: prompt.text });
  if (!res.ok) {
    throw new Error(res.error ?? '该步执行未成功（handleMessage 返回 ok:false）');
  }
  return {
    output: {
      prompt: prompt.text,
      assistantMessageId: res.assistantMessageId ?? null,
    },
    awaitUser: prompt.awaitUser,
    ...(prompt.pauseReason ? { pauseReason: prompt.pauseReason } : {}),
  };
}

/**
 * 情景演练执行器（SCENARIO-SPEC §8 M4，2026-09-17）：**唯一不走 chatStep 的步骤**。
 *
 * ★ 为什么专用：情景题的 demo/评分点/桥接是 M2 出题引擎的产物（generateScenario → 解析救援阶梯
 *   → saveScenario 闸门），聊天模型在对话流里吐不出能接上桥接的 demo——硬走脚本化提问等于
 *   绕开全部质量闸门。所以这里直接调引擎，再用与 REST 路由同一份 announceScenarioToSession
 *   把卡片推进聊天流（block 事件 + 历史落库，下发逻辑单份不漂移）。
 * ★ 对错记账不需要本执行器参与：用户在卡片里玩，回传走 /api/scenario/report——
 *   执行器只负责「把题送到」，停在这步等人玩（awaitsUser，同 quiz 步）。
 */
async function scenarioStep(ctx: FlowStepContext): Promise<FlowStepOutcome> {
  if (!ctx.sessionId) {
    throw new Error('该步骤需要一个会话才能执行——创建运行实例时未绑定会话');
  }
  const topic = typeof ctx.params.topic === 'string' ? ctx.params.topic.trim() : '';
  const material = typeof ctx.params.material === 'string' ? ctx.params.material.trim() : '';
  if (!topic && !material) {
    throw new Error('情景演练需要 topic 或 material 至少一项（同 REST 生成入口的入参闸门）');
  }
  const report = emptyScenarioGenReport();
  const gen = await generateScenario(topic || '综合', material || undefined, report, ctx.ownerId);
  if (!gen) {
    // 真因如实抛（ADR-5）：没配模型给绑定指引；解析失败说明可重试。不静默、不假装成功。
    throw new Error(
      report.failure === 'no-model'
        ? '情景题生成失败：出题模型没配好——请到「设置」→「角色模型绑定」为「出题」绑定模型后再试'
        : '情景题生成失败：模型输出没能解析成情景题（可重试本步；反复失败请换更强的出题模型）',
    );
  }
  announceScenarioToSession(ctx.sessionId, gen);
  return {
    output: {
      quizId: gen.quizId,
      demoId: gen.demoId,
      taskCount: gen.payload.tasks.length,
      title: gen.payload.title,
    },
    awaitUser: true,
    pauseReason: '情景题已生成，请在聊天流的卡片里完成；对错会自动记账',
  };
}

/**
 * 注册全部默认执行器（服务启动时调一次）。
 * `Map.set` 天然幂等，重复调用无副作用；但**测试注入 fake 前不要调它**，
 * 否则会把 fake 覆盖成真执行器（真执行器会走 LLM，CI 里跑不了）。
 * ★ scenario 是唯一的专用执行器，其余全部共享 chatStep（「加一种交互不动引擎」的唯一例外，
 *   例外理由见 scenarioStep 头注）。
 */
export function registerDefaultExecutors(): void {
  for (const meta of FLOW_STEP_METAS) registerExecutor(meta.kind, meta.kind === 'scenario' ? scenarioStep : chatStep);
}
