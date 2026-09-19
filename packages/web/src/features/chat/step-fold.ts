/**
 * step-fold —— SSE `step` 帧 → 过程卡片列表的折叠（纯函数，可单测）。
 * 2026-09-19 P1 从 `useChatStream` 抽出（本文件加 toolCallId 配对后放不下，行数红线）。
 *
 * ★ 配对键改为 `toolCallId`（契约 TOOL-ECOSYSTEM-SPEC §4.7）：旧实现按「name + 倒扫最近一条
 *   running」配对，**同名并行调用会串卡**——A 卡的终态盖到 B 卡上，两卡各错一半。
 *   id 由 tool-exec 调度器统一注入，同轮内恒唯一；缺失（旧历史/手搓帧）时终态**另起一条**，
 *   宁可多一张也不盖别人的（与既有「配不上 running 就新开」的兜底方向一致）。
 * ★ `startedAtMs` 是**客户端时钟**，只驱动 running 徽标的本地 tick（assistant-ui 原注：
 *   timing 只在流结束时定稿，live badge 必须自己起 timer）；终态一到即被服务端的
 *   `durationMs` 取代——这个值不落库、回放不带，就是「本地掐表只作过渡显示」的边界。
 */
import type { SseEvent } from '@sb/shared';

export interface ToolStep {
  tool: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  /** 工具入参原文（JSON 串）：过程卡片点开看 */
  args?: string;
  /** 工具结果摘要（截断 ~400 字）：同上 */
  result?: string;
  /** 模型侧 call id：终态按它配对（P1） */
  toolCallId?: string;
  /** 服务端实测执行耗时（ms），仅终态；缺失＝没测到（显示侧退「无时长」，不是 0 秒） */
  durationMs?: number;
  /** error 终态的人读错误（与 result 互斥，P1） */
  errorText?: string;
  /** running 帧到达的本地时刻：仅驱动进行中徽标的 tick，终态后被 durationMs 取代 */
  startedAtMs?: number;
}

type StepEvent = Extract<SseEvent, { type: 'step' }>;

/** 消化一条 step 帧，返回新数组（不改入参——ref 镜像模式下调用方整表替换） */
export function foldStepEvent(steps: ToolStep[], ev: StepEvent, now: number): ToolStep[] {
  if (ev.status === 'running') {
    return [...steps, { tool: ev.tool, status: ev.status, detail: ev.detail, toolCallId: ev.toolCallId, startedAtMs: now }];
  }
  const settled: ToolStep = {
    tool: ev.tool,
    status: ev.status,
    detail: ev.detail,
    args: ev.args,
    result: ev.result,
    toolCallId: ev.toolCallId,
    durationMs: ev.durationMs,
    errorText: ev.errorText,
  };
  if (ev.toolCallId) {
    const i = steps.findIndex((s) => s.toolCallId === ev.toolCallId && s.status === 'running');
    if (i >= 0) {
      const next = [...steps];
      next[i] = settled;
      return next;
    }
  }
  // 配不上 running（重连补发的终态、或 running 帧丢失）就新开一条：过程宁可多一条也不丢
  return [...steps, settled];
}
