/**
 * chat/tools/offer-pk-battle —— `offer_pk_battle` 工具（AI 主动发起对战，契约 `docs/PK-SPEC.md` §16.6）。
 *
 * 与 `ask_choice`（`chat/choice-tool.ts`）最关键的区别：**不挂起**。
 * 那边要拿到答复才能继续讲，所以 Promise 钉住整轮；这边是「邀请已发出，他还没决定」——
 * 钉住会话的代价是「他走开一会儿，这一轮就一直 busy」，而拒绝/不理会是这类邀请的**正常结局**，
 * 为一个可能被拒的东西钉住会话，等于把「可以拒绝」做成假承诺。
 *
 * ★ 注册动作在 `chat/tools/index.ts`（单一注册入口）。绕过那里直捅 registry 的后果有前例：
 *   `generate_quiz` 上线时漏挂，线上取证是「模型手里没有这个工具，只能退回打字给用户」
 *   （见那边文件头）。本批同款症状会是「AI 嘴上说要跟你打，屏幕上没有卡」。
 */
import { offerPkInvite, inviteToolHint } from '../../pk/invite.js';
import { PK_INVITE_REASON_MAX, TOPIC_MAX } from '@sb/shared';
import type { ToolDefinition } from '../../llm/types.js';
import { registerTool, zeroWritePlan } from './registry.js';

const TOOL = 'offer_pk_battle';

export const PK_BATTLE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL,
    description:
      '邀请学习者打一局 **AI 出题对战（PK）**：界面上会浮出一张可点「接受 / 拒绝」的卡片，' +
      '主题就是他刚学的内容，接受后进入 8 分钟人机对战（双方互出题、AI 也会答题）。' +
      '**本工具不等待他的决定**，调完请正常收尾本轮。' +
      '该用的时机：你把**一段成体系的内容讲完**了（一个概念讲透、一组公式推导完、一篇课文过完），' +
      '此刻检验他是否真会用的最好方式就是打一局。' +
      '不该用的时机：他还在问基础概念、正在纠错、情绪明显不想练，或者本轮只是闲聊——' +
      '那时发邀请是把「打断」当成「主动」。' +
      '★ 若返回「本次没发出去」（他手上还挂着没答复的卡／刚发过／今天发够了），' +
      '**这就是终点信号：不要重试、不要换个说法再发**，直接继续讲课。',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: `对战主题（≤${TOPIC_MAX} 字，取自当前对话，例如「高一数学 正弦定理」）`,
        },
        reason: {
          type: 'string',
          description: `给学习者看的一句话：为什么现在值得打一局（≤${PK_INVITE_REASON_MAX} 字）`,
        },
      },
      required: ['topic', 'reason'],
    },
  },
};

registerTool(TOOL, {
  definition: PK_BATTLE_TOOL,
  kind: 'write',
  /**
   * ★ 显式免确认（`§4.2` 的「语义上永远该免」那一档），不靠 `affected=1 < 默认阈值 5` 的巧合：
   *   `normalizeConfirmThreshold` 允许 0（0..50），而设置页把「全都问我」是合法选项——阈值 0 时
   *   `1 > 0` 成立 ⇒ 每张对战邀请先撞一张「批准这个提议」的确认卡，**两张卡叠在同一条决策上**，
   *   症状是「AI 说它发了邀请，屏幕上没有」。而邀请本身就是**用户已经在回答的 accept/reject**，
   *   再套一层批准＝让学习者先同意「能不能问他一句」，那不是确认而是把主动做成请示。
   *   代价如实记：这一行写的是 `pk_invites`（可拒、可过期、无破坏性），门后没有不可逆动作。
   */
  needsConfirm: false,
  /**
   * 两阶段写（§4.2/§4.6）：`affected` 恒记 **1**——一行 `pk_invites`（口径同 `generate_quiz` 的
   * 「记入库对象、不记题数」）。闸门挡下的那次自报 `affected: 0`，让 `tool_stats` 数得到
   * 「模型试了几次、其中几次被挡」——那是 §16.7 三条阈值将来调参的唯一数据来源。
   */
  async planWrite(args, ctx) {
    const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!ctx.sessionId) {
      return zeroWritePlan(`${TOOL} 发不出去：当前没有会话上下文，卡片没有可挂载的地方。请直接在回复里建议他去对战页。`);
    }
    if (!topic || !reason) {
      return zeroWritePlan(`${TOOL} 参数不全：topic 与 reason 都要给（topic ≤${TOPIC_MAX} 字，reason 一句话）。请修正后再调，或直接作答。`);
    }
    return {
      affected: 1,
      actionSummary: `邀请你打一局「${topic.slice(0, TOPIC_MAX)}」的 AI 出题对战`,
      items: [`主题：${topic.slice(0, TOPIC_MAX)}`, `说明：${reason.slice(0, PK_INVITE_REASON_MAX)}`],
      apply: async () => {
        const r = offerPkInvite({ sessionId: ctx.sessionId ?? '', ownerId: ctx.ownerId, topic: args.topic, reason: args.reason });
        if (!r.ok) {
          // ★ 闸门挡下**不是错误**：回灌的是「到此为止」的指令，不含任何重试暗示（§16.7）。
          //   写成 error 会让模型把它当瞬时故障重试，那正是刷屏的来源。
          //   「本次没发出去」这六个字与工具描述里的说法**逐字对齐**——描述教模型认这句话，
          //   回灌里却没有它，模型就只能自己猜这次是没发还是发了没点。
          ctx.onStep(TOOL, 'done', '本次没发出去');
          return { content: `${TOOL}：本次没发出去——${r.error}`, meta: { affected: 0 } };
        }
        ctx.onStep(TOOL, 'done', `已发出邀请：${r.record.topic}`);
        return { content: inviteToolHint(r.record), meta: { affected: 1 } };
      },
    };
  },
});
