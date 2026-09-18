/**
 * chat/flow — 单轮对话编排（chat 域唯一入口）。
 * 职责：会话串行锁（同会话消息不交错）/ abort 真断流 / 流式经 sse-bus 广播 /
 * 边流边累积末尾一次落库 / 用量兜底估算落库（v1 全部踩坑语义继承）。
 * 单轨原则（ADR/G3）：仅原生 function-calling，工具注册表见 chat/tools.ts。
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db.js';
import { routeRole } from '../llm/router.js';
import { getMaxOutputTokens } from '../llm/model-limits.js';
import { publish, startNewRound } from './sse-bus.js';
import { publishEvent } from '../events/bus.js';
import { estimateTokens, truncateHistoryToBudget, getContextLimit } from './context.js';
import { toolDefinitions, runTool } from './tools.js';
import type { ToolContext, ToolResult } from './tools.js';
import { runToolCalls, type StepPayload } from './tool-exec.js';
import { persistRounds, loadHistory } from './persist.js';
import { cancelChoicesBySession } from './choice.js';
import { compactIfNeeded } from './compact.js';
import { assembleContextMessages, collectContextSegments } from './context-segments.js';
import { TASKS_TOOL, parseTaskArgs, applyTaskPatch, formatTaskList, type TaskItem } from './task-list.js';
import { saveTerms, extractTerms, countUsage } from '../learning/terms.js';
import type { ChatMessage, ToolCall } from '../llm/types.js';
import { contentToText } from '../llm/types.js';
import { describeImages } from './vision.js';
import { runGrillClosing } from './grill.js';
import { buildOpening, dropOpening } from './opening.js';
import type { ChatOptions, ChatResult } from './options.js';

/**
 * 工具循环上限（v1 语义：模型连续发起工具调用时的轮次天花板，防死循环）。
 * 8 → 15（2026-09-10 老板指示：「8 轮少了」）：八轮在多步任务（查资料→对比→出清单）上
 * 常被截断在半途，硬上限反而制造「工具调用已达上限」的劣质收尾。
 * 死循环防护不靠这个数——`toolBudget` 每轮回灌后核对窗口占用，超了立即 break（见下），
 * 真正的兜底是预算而不是轮数；轮数只防「模型反复调工具但每次都只吃一点点窗口」。
 */
const MAX_TOOL_TURNS = 15;
/** 单条工具结果回灌上限（v1 语义：多轮工具调用会把上下文撑爆） */
const MAX_TOOL_RESULT_CHARS = 14_000;

/** 同会话串行锁：并发消息排队执行，绝不交错（v1 修复语义） */
const locks = new Map<string, Promise<unknown>>();

// 出入参契约已切到 `chat/options.ts`（2026-09-18，行数红线）。此处**转出**而非让调用方改路径——
// 契约搬家不该逼 6 个调用点跟着改 import（那只会制造一次无意义的全仓改动）。
export type { ChatOptions, ChatResult } from './options.js';

export function handleMessage(opts: ChatOptions): Promise<ChatResult> {
  const prev = locks.get(opts.sessionId) ?? Promise.resolve();
  const next = prev.then(() => runTurn(opts), () => runTurn(opts));
  locks.set(opts.sessionId, next);
  const cleanup = () => {
    if (locks.get(opts.sessionId) === next) locks.delete(opts.sessionId);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function runTurn(opts: ChatOptions): Promise<ChatResult> {
  const { sessionId } = opts;
  const db = getDb();

  // 看图蒸馏（v17）：图 → 视觉模型 → 文字描述。失败即向用户报真话并中止本轮，
  // 不污染主模型上下文、不落半截数据。蒸馏描述会拼进 userText 一并持久化，
  // 故历史回放 / 重新生成都不必二次调视觉模型。
  let visionDesc = '';
  if (opts.images && opts.images.length > 0) {
    try {
      visionDesc = await describeImages(opts.images, opts.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '图片理解失败';
      publish(sessionId, { type: 'chat-error', sessionId, message: msg });
      return { ok: false, error: msg };
    }
  }
  const userText = opts.text + (visionDesc ? `\n\n[图片内容]\n${visionDesc}` : '');

  // 用户消息落库（新会话以首句生成标题）。images 列仅作 UI 缩略图回显，主模型看到的是上面的 userText。
  // skipUserPersist：重新生成走这条路——提问本来就在库里（regenerate.ts 只删它之后的产物），再插一条就成了重复提问
  if (!opts.skipUserPersist) {
    db.prepare(`INSERT INTO messages (id, session_id, role, content, tokens, images) VALUES (?, ?, 'user', ?, ?, ?)`)
      .run(randomUUID(), sessionId, userText, estimateTokens(userText), JSON.stringify(opts.images ?? []));
  }
  const sessionTitle = (
    db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as { title: string } | undefined
  )?.title;
  if (sessionTitle === '新对话') {
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(opts.text.slice(0, 30) || '新对话', sessionId);
  }
  db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);
  const target = routeRole(opts.role ?? 'explain');
  if (!target || !target.model) {
    const msg = !target
      ? '没有可用的服务商：请到设置页添加 provider（baseUrl + apiKey）'
      : `角色 ${opts.role ?? 'explain'} 未配置模型：请到设置页完成角色模型绑定`;
    publish(sessionId, { type: 'chat-error', sessionId, message: msg });
    return { ok: false, error: msg };
  }

  startNewRound(sessionId);

  // 组装上下文。附加 system 段（摘要/词条/资料/偏好/画像/触发增强）的**构造、落位与预算核算**
  // 全在 chat/context-segments.ts —— 此前这三件事在本文件里各写一遍（同一份清单写两遍），
  // 加一段要改三处且漏一处不报错、只静默漂，故收成一份清单（理由见该文件头注释）。
  const { segments, systemPromptTokens, liveHistory } = collectContextSegments({
    history: loadHistory(sessionId),
    sessionId,
    // 检索词用 userText 而非 opts.text：发图时若只拿「这个怎么推导」去检索词条/资料，
    // 画面里的信息完全用不上（无图时两者恒等，老行为不变）
    text: userText,
    ownerId: opts.ownerId ?? null,
  });
  // 顺序不可换：截断要用段清单算出的预算，装配要用截断后的历史（截断含工具轮对齐）
  const truncated = truncateHistoryToBudget(liveHistory, {
    limit: getContextLimit(target.model),
    systemPromptTokens,
  });
  const { messages, nudgeMsg } = assembleContextMessages(segments, truncated);
  // 开场硬指令（grill-me / 联网，装配见 chat/opening.ts）：只在内存 messages 里活，不落库——它是指令不是发言
  const opening = buildOpening({ grill: opts.grillMe === true, online: opts.online === true });
  if (opening.msg) messages.push(opening.msg);
  // 工具循环预算：窗口 − 全部附加 system 段（`systemPromptTokens`，见 context-segments.ts）
  // − 已载历史 − 预留。每轮工具回灌后核对，接近上限提前收口——小上下文模型
  // 15 轮 × MAX_TOOL_RESULT_CHARS 会撑爆窗口（轮数上限由 8 提到 15 后，
  // 这条预算闸是唯一的窗口守门人，别把它当摆设）。
  const toolBudget = Math.max(
    0,
    getContextLimit(target.model) -
      systemPromptTokens -
      truncated.reduce((s, m) => s + estimateTokens((m.content || '') + (m.toolCalls ? JSON.stringify(m.toolCalls) : '')), 0) -
      20_000,
  );
  let toolTokens = 0;
  let budgetExceeded = false;

  let acc = '';
  /**
   * 本轮思考链：与 acc 同策略——边流边攒、收口时随消息一起落库。
   * 此前只 publish 不落库（见下方 chunk.reasoning 分支的原注释），刷新即永久丢失；
   * 「它刚才是怎么想的」在学习场景里是答案的一部分，故与正文同等持久化（v11 迁移加列）。
   */
  let reasoningAcc = '';
  /** 本轮的最终任务清单：patch 模式基于它增量合并，收口时随消息落库 */
  let latestTasks: TaskItem[] = [];
  let usage: { promptTokens: number; completionTokens: number } | undefined;

  /**
   * 追加收尾文本（上限提示 / 中断标记）：补进 acc 的与下发的是同一个 delta，
   * acc 因此恒等于已上屏文本——屏上与库内不会分叉（刷新前后一字不差）。
   */
  const appendFinal = (suffix: string) => {
    const delta = acc ? (acc.endsWith('\n') ? '' : '\n\n') + suffix : suffix;
    acc += delta;
    publish(sessionId, { type: 'token', sessionId, content: delta });
  };

  // 单轨工具循环（G3）：toolCalls → 执行 → tool 回灌 → 再生成；上限 MAX_TOOL_TURNS 轮。
  // update_tasks（任务清单）不在 tools.ts 注册表（该文件被并行会话在途改动，R1 避让）：
  // definition 拼进 tools 列表、执行走 exec 注入（runToolCalls 支持自定义执行器），零改动 tools.ts。
  const tools = [...toolDefinitions(), TASKS_TOOL.definition];
  const onStep = (
    tool: string,
    status: 'running' | 'done' | 'error',
    detail?: string,
    payload?: StepPayload,
  ) => {
    publish(sessionId, {
      type: 'step',
      sessionId,
      tool,
      status,
      detail,
      args: payload?.args,
      result: payload?.result,
    });
  };
  /**
   * 任务清单工具执行器：两种模式（全量 tasks / 增量 updates）→ 合并当前清单 →
   * 发 tasks 事件（**恒为完整清单**，前端整表替换）→ 回灌带序号的清单确认。
   * 回灌必须带序号：patch 模式靠 index 定位，模型看不到序号下一次就会错位。
   */
  const execTool = (name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> => {
    // grill-me 开场：给强绑产生的 ask_choice 打 pre 标记，前端据此把它沉进消息流（普通触发不带）
    if (name !== 'update_tasks') return runTool(name, argsJson, name === 'ask_choice' && opening.grill ? { ...ctx, grillPhase: 'pre' } : ctx);
    const parsed = parseTaskArgs(argsJson);
    if (!parsed.ok) return Promise.resolve({ content: parsed.content });
    if (parsed.mode === 'replace') {
      latestTasks = parsed.items;
    } else {
      const applied = applyTaskPatch(latestTasks, parsed.ops);
      // 整批原子：任一条非法就整批不生效，把「当前清单 + 序号」回灌给模型自纠
      if (!applied.ok) return Promise.resolve({ content: applied.content });
      latestTasks = applied.items;
    }
    publish(sessionId, { type: 'tasks', sessionId, items: latestTasks });
    return Promise.resolve({ content: formatTaskList(latestTasks) });
  };
  /** 工具轮攒到最终答案确认后一并落库：中途失败/中止不留孤儿 tool 消息（v1 语义） */
  const rounds: Array<{ calls: ToolCall[]; results: ChatMessage[] }> = [];
  const abortIfNeeded = () => {
    if (opts.signal?.aborted) throw new Error('已停止');
  };

  try {
    let pendingToolRound = false;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      abortIfNeeded();
      let turnText = '';
      let turnToolCalls: ToolCall[] | undefined;
      /** 本轮思考链：全局累积（落库）之外按轮另记一份——anthropic thinking + 工具循环时，
          assistant(tool_use) 轮必须把它那轮的思考块原样回灌，适配器从这里取（types.ChatMessage.reasoning） */
      let turnReasoning = '';
      for await (const chunk of target.adapter.chat({
        model: target.model,
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        messages,
        signal: opts.signal,
        tools,
        // 强绑只到 turn 0：turn 1 起必须放开，否则模型被锁死在开场动作上，正文永远出不来
        toolChoice: turn === 0 ? opening.toolChoice : undefined,
        // 显式传输出上限（B 系列防御）：不再依赖适配器 ?? getMaxOutputTokens 兜底，
        // 新增适配器漏写兜底时 Anthropic 会直接 400——类型层由 ChatRequest.maxTokens 承载。
        maxTokens: getMaxOutputTokens(target.model),
        // 池中 AI（stream_mode='once'）一次性回答；原生 AI 开思考链（仅 anthropic 适配器响应此开关）
        streamMode: target.streamMode,
        thinking: target.adapter.type === 'anthropic',
      })) {
        abortIfNeeded();
        if (chunk.reasoning) {
          // 边流式呈现、边累积落库（v11）：只发布不落库的话刷新即丢，重开会话看不到当时怎么想的
          turnReasoning += chunk.reasoning;
          reasoningAcc += chunk.reasoning;
          publish(sessionId, { type: 'reasoning', sessionId, content: chunk.reasoning });
        }
        if (chunk.content) {
          turnText += chunk.content;
          acc += chunk.content;
          publish(sessionId, { type: 'token', sessionId, content: chunk.content });
        }
        if (chunk.usage) {
          // 多轮各自计费：跨轮累加而非覆盖
          usage = {
            promptTokens: (usage?.promptTokens ?? 0) + chunk.usage.promptTokens,
            completionTokens: (usage?.completionTokens ?? 0) + chunk.usage.completionTokens,
          };
        }
        if (chunk.toolCalls && chunk.toolCalls.length > 0) turnToolCalls = chunk.toolCalls;
        if (chunk.done) break;
      }

      if (!turnToolCalls) {
        pendingToolRound = false;
        break; // 无工具调用 → 本轮即最终回答
      }

      const results: ChatMessage[] = [];
      // 并行执行 + 单工具超时 + 中止即停（契约 §4.3）：原来是 for 循环裸 await，
      // 多工具时耗时叠加，且长工具期间「停止」按钮形同虚设（signal 没进执行环节）。
      // 结果按调用顺序回灌，顺序稳定性＝回归锁可钉（见 chat/tool-exec.test.ts）。
      const outcomes = await runToolCalls(turnToolCalls, { onStep }, {
        signal: opts.signal,
        exec: execTool,
        // 会话 id 透传：ask_choice 据此把提问绑到当前会话（方案选择框）
        sessionId,
        // ask_choice 要等学习者点选、契约不设超时——不豁免就会被 30s 默认超时掐断（见 tool-exec.ts）
        noTimeout: ['ask_choice'],
      });
      abortIfNeeded();
      for (const o of outcomes) {
        results.push({ role: 'tool', content: o.content.slice(0, MAX_TOOL_RESULT_CHARS), toolCallId: o.id });
      }
      rounds.push({ calls: turnToolCalls, results });
      messages.push({ role: 'assistant', content: '', toolCalls: turnToolCalls, reasoning: turnReasoning || undefined }, ...results);
      toolTokens +=
        estimateTokens(JSON.stringify(turnToolCalls)) + results.reduce((s, r) => s + estimateTokens(contentToText(r.content)), 0);
      if (turnText) {
        acc += '\n\n'; // 过程语与下一轮正文之间留分隔（已流式上屏，不能粘连）
        publish(sessionId, { type: 'token', sessionId, content: '\n\n' }); // 分隔符同样下发：屏上与库内文本逐字一致
      }
      pendingToolRound = true;
      // 首轮一过就摘触发增强与开场指令（联网留着每轮重搜、nudge 留着会再问，都只对开场负责）
      if (turn === 0) {
        const i = nudgeMsg ? messages.indexOf(nudgeMsg) : -1;
        if (i >= 0) messages.splice(i, 1);
        dropOpening(messages, opening);
      }
      if (toolTokens > toolBudget) {
        budgetExceeded = true;
        break; // 预算耗尽，提前停止工具循环（预留收尾窗口）
      }
    }

    dropOpening(messages, opening);

    if (pendingToolRound) {
      const capMsg = budgetExceeded
        ? '上下文预算已满，工具调用提前停止；请基于已有内容作答或开始新对话。'
        : `工具调用已达上限（${MAX_TOOL_TURNS} 轮），已停止；请调整提问或直接要求作答。`;
      appendFinal(capMsg);
      publish(sessionId, { type: 'chat-error', sessionId, message: capMsg });
    }

    const assistantId = persistRounds(sessionId, rounds, acc, usage?.completionTokens ?? estimateTokens(acc), {
      reasoning: reasoningAcc,
      tasks: latestTasks,
    });
    db.prepare(`INSERT INTO token_usage (session_id, model, prompt_tokens, completion_tokens, source) VALUES (?, ?, ?, ?, ?)`)
      .run(
        sessionId,
        target.model,
        usage?.promptTokens ?? estimateTokens(messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')),
        usage?.completionTokens ?? estimateTokens(acc),
        usage ? 'provider' : 'estimated',
      );
    db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);

    publishEvent({ type: 'chat_done', sessionId });
    // 忆域 v2：回复完成后自动抽取重要词条入库（失败静默不阻塞对话）+ 命中词条计数
    void extractTerms(`${opts.text}\n\n${acc}`.slice(0, 30000))
      .then((items) => {
        if (items.length > 0) saveTerms(items, sessionId);
      })
      .catch(() => undefined)
      // 长期记忆压缩排在词条抽取**之后**串行（两者都要打一次 LLM，并发会同时占两个配额槽），
      // 且不 await——摘要下一轮才生效，本轮用户已拿到回答（MEMORY-SPEC §4.1）。
      .finally(() => {
        void compactIfNeeded(sessionId, opts.ownerId ?? null);
      });
    countUsage(acc);
    publish(sessionId, {
      type: 'done',
      sessionId,
      usage: {
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        source: usage ? 'provider' : 'estimated',
      },
    });
    // v18.3 grill-me 收尾：抛出「下一步」选项卡。**必须放在 done 帧之后**——
    // 此前卡在 chat_done 之前弹出，而前端 busy 要等 done 帧才解除：卡片已可点、
    // 点了却被 useSendActions 的 busy 门禁静默拒绝（void 吞掉 {ok:false}），
    // 实测表现为「点了收尾卡模型不动」（2026-09-17）。
    // SSE 是会话级持久订阅（sse-client，与 POST /chat/send 分离，断线回放兜底），
    // done 之后发帧照样送达；失败一律静默，不能让已上屏的回答变出错。
    if (opts.grillMe) {
      await runGrillClosing({ sessionId, adapter: target.adapter, model: target.model, apiKey: target.apiKey,
        baseUrl: target.baseUrl, messages, tools, signal: opts.signal, onStep });
    }
    return { ok: true, assistantMessageId: assistantId };
  } catch (err) {
    const aborted = opts.signal?.aborted === true;
    const msg = err instanceof Error ? err.message : String(err);
    // 逃生口①：本轮异常 / 被停止时连带作废本会话挂起的方案选择。
    // 必做——挂起的 ask_choice 不在 signal 的掐断路径上，它等的是「人点一下」；
    // 用户既然选了停止，就再没人会点那张卡，不作废工具会永久悬挂（会话锁也一起卡住）。
    cancelChoicesBySession(sessionId, aborted ? '用户已停止生成' : '本轮生成中断');
    // 流什么就存什么：已上屏的字不留白（中止与中途失败同样收口）。
    // 工具轮仍不落，绝不留孤儿 tool 消息。
    if (acc) {
      appendFinal(`（${aborted ? '已停止' : '生成中断'}）`);
      // 中断也把已攒下的思考与任务清单带上：工具轮不落（防孤儿 tool 消息），
      // 但过程文本本身无害且有用——「它刚才想到哪一步」正是中断后最想看的
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, tokens, reasoning, tasks) VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        sessionId,
        acc,
        estimateTokens(acc),
        reasoningAcc || null,
        latestTasks.length > 0 ? JSON.stringify(latestTasks) : null,
      );
    }
    publish(sessionId, { type: 'chat-error', sessionId, message: aborted ? '已停止' : `生成失败：${msg}` });
    // 失败也要收口：缓冲里留下终止帧，切回会话时不会重放这半截死流
    publish(sessionId, { type: 'done', sessionId });
    return { ok: false, error: msg };
  }
}

// persistRounds / loadHistory 已搬至 chat/persist.ts
// （2026-09-14 为方案选择框接线腾 400 行门禁空间，零行为改动）
