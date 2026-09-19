/**
 * chat/tools/write-gate —— 两阶段写的决策缝（契约 TOOL-ECOSYSTEM-SPEC §4.6，P3）。
 * registry 只留一个 `if (tool.planWrite)` 接缝，全部决策逻辑在这里：
 * plan（只算不改）→ 免确认直接 apply ／ 需确认挂起等裁决（confirm.ts）→ **拒绝或超时
 * 路径下 `apply()` 调用次数恒为 0**（§4.6-4，P3 回归锁钉死）→ 批准同轮 apply（§4.6-3，
 * 不把已批方案挂到下一轮——防「批的是 A、跑的是 B」）。
 *
 * 两个刻意的小偏离（都写进契约 §4.6 落码注，不是暗改）：
 * · `affected === 0` 不弹卡——「批准一次零改动」没有问题可答，gate 直接 apply 让工具
 *   如实汇报（delete 的名找不到就是这个形态）；
 * · 无 `sessionId` 时**保守拒绝**而不是放行——确认送不出去＝没有人同意过，按最严档收口。
 */
import type { ConfirmPolicy, ToolConfirmDecision } from '@sb/shared';
import { loadConfirmThreshold } from '../../storage/confirm-threshold.js';
import { grantSessionAllow, isSessionAllowed, requestConfirmation, sessionAllowKey } from './confirm.js';
import type { RegisteredTool, ToolContext, ToolResult } from './registry.js';

/** kind 的缺省确认档（§4.2 表；唯一判定处，注册方省略 needsConfirm 时从这里推） */
export function defaultConfirmPolicy(kind: RegisteredTool['kind']): ConfirmPolicy {
  if (kind === 'write') return 'by_size';
  if (kind === 'external') return true;
  return false;
}

/** 拒绝/超时回灌（§4.6-4 原文口径）：两条分开写，超时那条要说明"没等到"而不是"用户说不" */
export const CONFIRM_DENY_HINT =
  '用户未批准本次改动。请勿重复发起同一修改，改为把建议用文字告诉用户（也可以问用户想怎么调）。';
export const CONFIRM_TIMEOUT_HINT =
  '确认请求超时（用户 60 秒未答复），本次改动**未执行**。请勿自动重试，改为把建议用文字告诉用户。';

/** 卡片摘要裁剪（契约 §4.2 注：≤8 行、每行 ≤40 字，超出折叠成「…等 N 条」） */
const CARD_ITEMS_MAX = 8;
const CARD_ITEM_CHARS = 40;

export function cardItems(items: string[], total: number): string[] {
  const head = items.slice(0, CARD_ITEMS_MAX).map((s) => (s.length > CARD_ITEM_CHARS ? `${s.slice(0, CARD_ITEM_CHARS - 1)}…` : s));
  if (total > head.length) head.push(`…等 ${total} 条`);
  return head;
}

/**
 * 写门面的唯一执行路径。`tool` 由 registry 传入（已经过 schema 预闸），
 * 本函数内 `apply()` 只有三个到达点：免确认档 / 已批一次 / 会话授权命中——
 * 回归锁用 spy 计 apply 调用数验证「拒绝与超时都是 0」。
 */
export async function runWriteGate(
  name: string,
  tool: RegisteredTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const plan = await tool.planWrite?.(args, ctx);
  if (!plan) {
    return { content: `已核对：${name} 本次没有需要落库的改动，未写库。请用一句话向用户说明。`, meta: { affected: 0, confirm: null } };
  }
  const policy = tool.needsConfirm ?? defaultConfirmPolicy(tool.kind);
  // 阈值**只在 by_size 真要做裁决时**才读（免确认/必确认档根本不碰 app_settings——
  // 也就不碰 DB，registry/tool-exec 的「不触 DB」测试边界不被打穿）
  const threshold = policy === 'by_size' ? (tool.confirmThreshold ?? loadConfirmThreshold(ctx.ownerId)) : 0;
  const needsConfirm = plan.affected > 0 && (policy === true || (policy === 'by_size' && plan.affected > threshold));

  let decision: ToolConfirmDecision | null = null;
  if (needsConfirm) {
    const allowKey = ctx.sessionId ? sessionAllowKey(ctx.sessionId, name, String(policy)) : null;
    if (allowKey && isSessionAllowed(allowKey)) {
      decision = 'allow_session'; // 会话授权命中：留痕记 allow_session，不是"没经过门"
    } else if (!ctx.sessionId) {
      return {
        content: `${CONFIRM_DENY_HINT}（技术原因：本次调用没有可送达的会话上下文，确认卡发不出去。）`,
        meta: { affected: null, confirm: 'deny' },
      };
    } else {
      ctx.onStep(name, 'running', '等待你批准');
      const verdict = await requestConfirmation(
        {
          sessionId: ctx.sessionId,
          tool: name,
          source: tool.kind === 'external' ? 'mcp' : 'builtin',
          actionSummary: plan.actionSummary,
          affected: plan.affected,
          items: cardItems(plan.items, plan.affected),
        },
        ctx.signal,
      );
      decision = verdict;
      if (verdict === 'deny' || verdict === 'timeout') {
        return {
          content: verdict === 'deny' ? CONFIRM_DENY_HINT : CONFIRM_TIMEOUT_HINT,
          meta: { affected: null, confirm: verdict },
        };
      }
      if (verdict === 'allow_session' && allowKey) grantSessionAllow(allowKey);
    }
  }
  const result = await plan.apply();
  return {
    ...result,
    meta: {
      ...result.meta,
      // affected 以 apply 的自报为优先（§4.6-5 apply 内重校验后**实际**改了才是事实），
      // 工具没自报才回退 plan.affected（计划值——apply 语义是"照计划执行"，两者不等即中止）
      affected: result.meta?.affected ?? plan.affected,
      confirm: result.meta?.confirm ?? decision,
    },
  };
}
