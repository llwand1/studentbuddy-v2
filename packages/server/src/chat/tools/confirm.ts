/**
 * chat/tools/confirm — 确认门的挂起与裁决（契约 TOOL-ECOSYSTEM-SPEC §4.6/§6.3-4，P3 核心）。
 *
 * 形状抄 `chat/choice.ts` 的三条纪律（那里踩过的坑这里原样避开）：
 * ① **先登记 waiter 再 publish**——用户极速点选时 `resolveConfirmation` 必须找得到它；
 * ② **恒 resolve 不 reject**——拒绝也要让工具体拿到一份权威结果去决定怎么回灌模型，
 *    用异常表示拒绝会走 runTool 的 catch 变成「工具执行失败」，模型看到的是报错而不是
 *    「用户未批准，请勿重复发起」这种可继续的指令；
 * ③ 一个 requestId 只有**一个裁决者**：settle 即删 waiter，迟到的第二次点选拿 409。
 *
 * 与 choice 的两个刻意差异：
 * · **不落库**（拍板：批准状态存内存随会话，重启回到最严档）——确认挂在**进行中的那一轮**上，
 *   进程重启那一轮早死了，落库只会造出「库里可批、无人可续」的假状态；
 * · **60s 服务端定时代答 timeout**（§6.3-4「无回执按拒绝」）——choice 是「不选就一直等」，
 *   这里不许等：写操作的挂起占着会话串行锁，无人裁决的挂起必须自己收口。
 *
 * 「停止生成」路径：`signal` 进本文件，中止即按 deny 收口并广播 resolved——
 * 卡片不留在屏上变死卡，等待中的调用也不再占 timer。
 */
import { randomUUID } from 'node:crypto';
import { CONFIRM_TIMEOUT_MS } from '@sb/shared';
import type { ToolConfirmDecision, ToolConfirmRequest } from '@sb/shared';
import { publish } from '../sse-bus.js';

/** 终态回执的短期存根：只够给迟到的第二次点选回 409（与 404「不存在」区分开），不留审计 */
const SETTLED_STUB_TTL_MS = 5 * 60_000;

interface PendingConfirm {
  sessionId: string;
  resolve: (d: ToolConfirmDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** requestId → 挂起中的确认（同 choice.ts 的 waiters：本模块唯一的进程内状态） */
const waiters = new Map<string, PendingConfirm>();
const settledStubs = new Map<string, ToolConfirmDecision>();

/**
 * 「本会话允许」的记忆表：key = `会话|工具|确认档`（§6.3-4——只对同一工具+同一确认档生效，
 * 不升级为跨工具通行证；落库违拍板「重启回最严」，故恒为内存 Set）。
 */
const sessionAllowed = new Set<string>();

export function sessionAllowKey(sessionId: string, tool: string, policyKey: string): string {
  return `${sessionId}|${tool}|${policyKey}`;
}

export function isSessionAllowed(key: string): boolean {
  return sessionAllowed.has(key);
}

export function grantSessionAllow(key: string): void {
  sessionAllowed.add(key);
}

/** 发起确认的入参：载荷形状即 `ToolConfirmRequest`（去掉服务端生成的两个字段），再加投递目的地 */
export type ConfirmRequestInput = Omit<ToolConfirmRequest, 'requestId' | 'expiresAt'> & { sessionId: string };

/** 客户端不许传 timeout（那是服务端定时器的代答）；allow/deny 之外一律拒 */
const CLIENT_DECISIONS: readonly string[] = ['allow_once', 'allow_session', 'deny'];

function broadcastResolved(sessionId: string, requestId: string, decision: ToolConfirmDecision): void {
  publish(sessionId, { type: 'tool-confirm-resolved', sessionId, requestId, decision });
}

/** 统一收口：结算 → 清理 → 广播（顺序讲究见头注②：resolve 是恒 resolve，不抛） */
function settle(requestId: string, decision: ToolConfirmDecision): void {
  const p = waiters.get(requestId);
  if (!p) return;
  waiters.delete(requestId);
  clearTimeout(p.timer);
  settledStubs.set(requestId, decision);
  setTimeout(() => settledStubs.delete(requestId), SETTLED_STUB_TTL_MS).unref?.();
  broadcastResolved(p.sessionId, requestId, decision);
  p.resolve(decision);
}

/**
 * 发起一次确认请求并挂起等待。调用方（write-gate）已裁好 items ≤8 行×≤40 字；
 * 本函数不再校验载荷形状——那是契约的字段，编译期已钉（`ConfirmRequestInput`）。
 */
export function requestConfirmation(input: ConfirmRequestInput, signal?: AbortSignal): Promise<ToolConfirmDecision> {
  const requestId = randomUUID();
  const expiresAt = Date.now() + CONFIRM_TIMEOUT_MS;
  return new Promise<ToolConfirmDecision>((resolve) => {
    const timer = setTimeout(() => settle(requestId, 'timeout'), CONFIRM_TIMEOUT_MS);
    timer.unref?.(); // 挂起的确认不该钉住进程退出（测试与优雅停机场景）
    waiters.set(requestId, { sessionId: input.sessionId, resolve, timer });
    if (signal) {
      const onAbort = (): void => settle(requestId, 'deny');
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    publish(input.sessionId, {
      type: 'tool-confirm-request',
      sessionId: input.sessionId,
      requestId,
      tool: input.tool,
      source: input.source,
      ...(input.server ? { server: input.server } : {}),
      actionSummary: input.actionSummary,
      affected: input.affected,
      items: input.items,
      expiresAt,
    });
  });
}

export type ConfirmAnswerResult = { ok: true } | { ok: false; status: number; error: string };

/** 用户回执入口（POST /api/chat/tool-confirm）。404＝不存在/已过期清理，409＝已有裁决 */
export function resolveConfirmation(requestId: string, rawDecision: unknown): ConfirmAnswerResult {
  if (typeof rawDecision !== 'string' || !CLIENT_DECISIONS.includes(rawDecision)) {
    return { ok: false, status: 400, error: 'decision 只能是 allow_once / allow_session / deny' };
  }
  if (!waiters.has(requestId)) {
    return {
      ok: false,
      status: settledStubs.has(requestId) ? 409 : 404,
      error: settledStubs.has(requestId) ? '该请求已有裁决，不再接受答复' : '确认请求不存在或已过期',
    };
  }
  settle(requestId, rawDecision as ToolConfirmDecision);
  return { ok: true };
}

/** 作废某会话全部挂起确认（删会话端点用；停止生成走 signal 路径不经这里） */
export function cancelConfirmationsBySession(sessionId: string): number {
  const ids = [...waiters.entries()].filter(([, p]) => p.sessionId === sessionId).map(([id]) => id);
  for (const id of ids) settle(id, 'deny');
  // 「本会话允许」随会话消亡——不删的话换个会话名重放就白拿通行证
  for (const key of [...sessionAllowed]) if (key.startsWith(`${sessionId}|`)) sessionAllowed.delete(key);
  return ids.length;
}

/** 仅供单测断言「拒绝/超时后没有残留状态」 */
export function pendingConfirmCount(): number {
  return waiters.size;
}
