/**
 * run-status —— 运行状态 → UI 文案与可用动作的**纯映射**（契约 docs/STUDY-FLOW-SPEC.md §6.2）。
 *
 * ★ 为什么单独成文件而不是散在组件里：这套映射是**服务端状态机的镜像**，
 *   一旦与服务端的 `advanceRun` 判定不一致，用户就会看到「按钮亮着但一点就 409」——
 *   这是最招人烦的一类 bug，也是最适合用单测钉死的一类。
 *   服务端口径（`study-flow-run.ts`）：仅 `running` / `paused` 可推进。
 *
 * ★ 前端**不自己推下一步是什么**：运行详情里服务端已给出 `currentStepId` 与逐步轨迹，
 *   每步「要跑什么」由运行器决定；前端只负责把状态说清楚、把按钮给对。
 */
import { FLOW_MAX_STEPS } from '@sb/shared';
import type { FlowRun, FlowRunStatus, FlowRunStepStatus } from '@sb/shared';
import type { ParamProblem } from './flow-form';

export function runStatusLabel(status: FlowRunStatus): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'paused':
      return '等你操作';
    case 'done':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已终止';
    default:
      return status;
  }
}

/** 状态色调的 CSS 类后缀（配色在 flow.css 按 status 分档） */
export function runStatusTone(status: FlowRunStatus): string {
  return `fl-run-status ${status}`;
}

export function stepStatusLabel(status: FlowRunStepStatus): string {
  switch (status) {
    case 'running':
      return '执行中';
    case 'done':
      return '完成';
    case 'failed':
      return '失败';
    case 'skipped':
      return '跳过';
    default:
      return status;
  }
}

export type Gate = { ok: true } | { ok: false; reason: string };

/**
 * 能否推进这一步。**与服务端 `advanceRun` 的判定逐条对齐**（包括错误文案的口径）。
 * 不能推进时给出**具体原因**而不是一句「不可用」——用户需要知道是走完了还是出错了。
 */
export function advanceGate(run: FlowRun): Gate {
  if (run.status === 'done') return { ok: false, reason: '这条流已经走到终点' };
  if (run.status === 'cancelled') return { ok: false, reason: '这条运行已终止，想要新的一轮请重新开始' };
  if (run.status === 'failed') return { ok: false, reason: run.error ?? '这条运行已失败' };
  // ★ 防死循环：超上限时服务端会把运行判失败，前端提前拦住，别让用户白点一次
  if (run.stepCount >= FLOW_MAX_STEPS) {
    return { ok: false, reason: `已达单次运行上限（${FLOW_MAX_STEPS} 步）` };
  }
  return { ok: true };
}

/** 能否终止：仅 running / paused（与服务端一致，幂等语义如实反映） */
export function canCancel(run: FlowRun): boolean {
  return run.status === 'running' || run.status === 'paused';
}

/** 主按钮文案：跑过的流再点就是「继续」，第一次是「开始」 */
export function advanceButtonText(run: FlowRun): string {
  if (run.status === 'paused') return '继续下一步';
  return run.stepCount === 0 ? '开始学习' : '继续下一步';
}

/**
 * 停等说明。服务端 `pauseReason` 优先（它知道**在等什么**），没有则给一句通用说明。
 * ★ 绝不返回空串：paused 状态下用户必须看到「为什么停了」，否则会以为程序卡死。
 */
export function pauseHint(run: FlowRun): string {
  if (run.status !== 'paused') return '';
  return run.pauseReason ?? '这一步需要你的操作，处理完点「继续下一步」';
}

/** 步数进度文案（列表与详情共用） */
export function runProgressText(run: FlowRun): string {
  return `已执行 ${run.stepCount} / 上限 ${FLOW_MAX_STEPS} 步`;
}

/** `defVersion` 的展示：运行冻结的是**当时那一版**定义，改过定义后这个数会不同（契约 §6.3） */
export function frozenVersionText(run: FlowRun): string {
  return `定义 v${run.defVersion}`;
}

/**
 * 草稿状态 → 「开始新一轮」该不该拦、理由是什么（`RunPanel` 的 `blockedReason` 直接吃它）。
 *
 * ★ 两条拦的理由**有先后、不可互相覆盖**：
 *   ① **未保存改动优先**——此时运行冻结的是**库里那一版**（`flow_run.def_snapshot`），
 *      先说"你改的还没生效"才准确；先报参数问题会让用户以为"改完了就能跑"。
 *   ② **参数没填好**——必须**带 `stepId`**，面板上才有「去改这一步」可点。不拦的话点下去
 *      会被服务端 400 弹一句「缺少必填参数」，用户收到的是"你被拒了"而不是"去改哪一步"
 *      （2026-09-17 老板实测反馈的那句）。
 *
 * ★ 从 `FlowPage` 抽出来：既守住 `.tsx ≤300 行` 红线，也让这条"先因后果"的顺序能被单测钉住。
 */
export function runBlockReason(opts: {
  dirty: boolean;
  problems: ParamProblem[];
}): { blockedReason: string; blockedStepId?: string } | null {
  if (opts.dirty) {
    return { blockedReason: '有未保存的改动——先保存，运行跑的才是你编排的这一版' };
  }
  const [first] = opts.problems;
  if (!first) return null;
  return {
    blockedReason: `还有 ${opts.problems.length} 处参数没填好，跑到那一步会被拦下`,
    blockedStepId: first.stepId,
  };
}
