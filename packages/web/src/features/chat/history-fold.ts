/**
 * history-fold —— 把 GET /sessions/:id/messages 的原始行折成前端消息流。
 *
 * 为什么要折：库里一次问答写成多条行——user → assistant(空正文, tool_calls) → tool(结果)
 * → …（可多轮）→ assistant(正文, reasoning, tasks)。前面几类都是「这一次回答的过程」，
 * 不是独立消息。主流（Claude / ChatGPT）把过程归属于那条回答；本模块按同一口径，把工具轮
 * 配对成 steps 挂到紧随其后的那条 assistant 正文上，思考链与任务清单则直接读该行的列
 * （v11 起随消息落库），从而让重开会话能原样回放整段过程。
 *
 * 纯函数：吃原始行、吐 StreamMessage[]，不碰 DOM 也不碰 React，可直接单测。
 */
import type { StreamMessage, TaskItem, ToolStep } from './useChatStream';
import { restoreScenarioBlock } from './chat-blocks';

/** /messages 下发的原始行（口径见服务端 routes.ts 的 SELECT；多出的字段这里不用） */
export interface HistoryRow {
  id: string;
  role: string;
  content: string;
  /** 该行是工具调用轮时：JSON 串 [{id,name,arguments}] */
  tool_calls?: string | null;
  /** 该行是工具结果时：它回填给哪个 call */
  tool_call_id?: string | null;
  /** 该行是回答时：本轮思考链原文（v11 起随消息落库） */
  reasoning?: string | null;
  /** 该行是回答时：update_tasks 最后一次全量的 JSON 串（v11 起随消息落库） */
  tasks?: string | null;
  /** v17 看图：用户上传图片（base64 dataURL JSON 数组），仅作缩略图回显 */
  images?: string | null;
  /** v32（P1）：assistant 回答行的思考耗时（ms）；NULL＝该消息没有实测值（老数据/没出过思考） */
  thinking_ms?: number | null;
  /** v32（P1）：tool 结果行的实测执行耗时（ms）——刷新/切会话后卡片耗时不变的事实源 */
  duration_ms?: number | null;
  created_at: string;
}

/** tool_calls JSON 的元素形状（弱模型/历史数据可能缺字段，故全部可选） */
interface RawCall {
  id?: string;
  name?: string;
  arguments?: string;
}

/** 工具结果摘要截断：与流式期 SSE step.result 同口径（flow.ts 侧同为 400） */
const RESULT_CAP = 400;

function parseCalls(raw: string | null | undefined): RawCall[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as RawCall[]) : [];
  } catch {
    return []; // 坏 JSON 视作没有工具调用：不让一行脏数据毁掉整段历史
  }
}

/** 任务清单同样按 JSON 存（v11），坏数据视作没有清单 */
function parseTasks(raw: string | null | undefined): TaskItem[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.length > 0 ? (v as TaskItem[]) : undefined;
  } catch {
    return undefined;
  }
}

export function foldToolRounds(rows: HistoryRow[]): StreamMessage[] {
  const out: StreamMessage[] = [];
  /** 正在累积的一轮工具步骤：遇到正文 assistant 时整体挂给它 */
  let pending: ToolStep[] = [];
  /** tool_call_id → 步骤对象引用，用于把 tool 结果回填到对应步骤 */
  const byCallId = new Map<string, ToolStep>();

  for (const r of rows) {
    if (r.role === 'user') {
      // 上一轮若留下悬空步骤（异常中断），不跨轮污染：直接丢弃未收口的 pending
      pending = [];
      byCallId.clear();
      let images: Array<{ dataUrl: string; name?: string }> | undefined;
      if (r.images) {
        try {
          const v = JSON.parse(r.images) as Array<{ dataUrl: string; name?: string }>;
          if (Array.isArray(v) && v.length > 0) images = v;
        } catch {
          /* 坏 JSON 视作无图：不让脏数据毁掉整段历史 */
        }
      }
      out.push({ role: 'user', content: r.content, ts: r.created_at, ...(images ? { images } : {}) });
      continue;
    }

    if (r.role === 'assistant') {
      const calls = parseCalls(r.tool_calls);
      if (calls.length > 0) {
        // 工具轮：正文恒为空，不产出可见消息，只把每个 call 展开成一条 running 步骤
        for (const c of calls) {
          const step: ToolStep = { tool: c.name ?? 'unknown', status: 'running', args: c.arguments };
          if (c.id) byCallId.set(c.id, step);
          pending.push(step);
        }
        continue;
      }
      // 正文 assistant：把累积的过程整块挂给它（无工具轮则 steps 为 undefined；
      // reasoning / tasks 是 v11 起直接存在这条行上的列，一并对上）
      // 情景题历史行（M3，契约 SCENARIO-SPEC §8）：[SCENARIO] 登记文本还原成卡片——
      // 还原失败回落普通文本，不让一行旧数据毁掉整个会话的加载
      const scenario = restoreScenarioBlock(r.content);
      if (scenario) {
        out.push({
          role: 'assistant',
          content: '',
          ts: r.created_at,
          scenarioBlock: scenario,
          steps: pending.length > 0 ? pending : undefined,
        });
        pending = [];
        byCallId.clear();
        continue;
      }
      out.push({
        role: 'assistant',
        content: r.content,
        ts: r.created_at,
        steps: pending.length > 0 ? pending : undefined,
        reasoning: r.reasoning || undefined,
        ...(r.thinking_ms != null ? { thinkingMs: r.thinking_ms } : {}), // 思考耗时与 done 帧同源（v32 列）
        tasks: parseTasks(r.tasks),
      });
      pending = [];
      byCallId.clear();
      continue;
    }

    if (r.role === 'tool') {
      const step = r.tool_call_id ? byCallId.get(r.tool_call_id) : undefined;
      if (step) {
        step.status = 'done';
        step.result = r.content.slice(0, RESULT_CAP);
        // v32：工具实测耗时随行落库，回放同值（§4.7「刷新后数字不变」判据的存储侧）
        if (r.duration_ms != null) step.durationMs = r.duration_ms;
      }
    }
  }

  // 收尾：有工具轮但这一轮没写出正文（被停止 / 纯工具轮）→ 单独留一条空正文消息。
  // 过程不能因为「没有正文」就丢掉；渲染层对「正文为空但有 steps」的消息照样渲染。
  if (pending.length > 0) out.push({ role: 'assistant', content: '', steps: pending });
  return out;
}
