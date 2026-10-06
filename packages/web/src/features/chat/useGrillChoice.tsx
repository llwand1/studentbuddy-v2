/**
 * useGrillChoice — grill-me 模式的前端侧（v18，2026-09-16）。
 *
 * 为什么 hook 直接吐出 `grillNode`：`ChatView.tsx` 贴 300 行门禁，grill-me 要加
 * 「模式状态 + 点选编排 + 消息流卡片接线」三十余行，全塞进 ChatView 必破线。
 * 本仓对此有成熟先例——`useChoiceQueue`、`useSendActions`、`composer-status` 都是从
 * ChatView/useChatStream 里抽出来的；这里进一步把卡片也一并托管，调用方只落 4 行接线。
 *
 * 两段提问语义相反，别搞混（服务端同口径见 `chat/grill.ts`）：
 * - pre 段：答复回灌模型，模型据此作答 ⇒ 前端什么都不用做。
 * - post 段：本轮已结束、答复**不回灌** ⇒ 前端必须把选中项作为**新一轮提问**发出，
 *   否则点了选项毫无反应。
 */
import { useEffect, useRef, useState } from 'react';
import { normalizeGrillScope, type AskChoiceRecord, type GrillScope } from '@sb/shared';
import { ChoiceCard, type ChoiceReplyPayload } from './ChoiceCard';

export interface GrillChoiceDeps {
  sessionId?: string | null;
  /** 队首挂起项（来自 useChoiceQueue）；带 grillPhase 的才是 grill-me 的卡 */
  pendingChoice: AskChoiceRecord | null;
  replyChoice: (requestId: string, reply: { optionId?: string; custom?: string }) => void;
  /** 真作废后端挂起的提问（只收起前端会让阻塞整轮的工具永久悬挂） */
  skipChoice: (requestId: string) => void;
  /** 发一条新提问（post 段点选后开新一轮） */
  send: (
    text: string,
    images?: Array<{ dataUrl: string; name?: string }>,
    grillMe?: boolean,
    grillScope?: GrillScope,
  ) => Promise<{ ok: boolean; error?: string }>;
  regenerate?: (grillMe?: boolean, scope?: GrillScope) => Promise<{ ok: boolean; error?: string }>;
  resend?: (text: string, grillMe?: boolean, scope?: GrillScope) => Promise<{ ok: boolean; error?: string }>;
  /**
   * post 点选后 send 失败的上报口（v18.3）：此前 `void send(...)` 把 {ok:false}
   * 整个吞掉——busy 门禁拒绝时**零提示**，用户看到的就是「点了卡模型不动」。
   */
  onSendError?: (msg: string) => void;
}

export function useGrillChoice({ sessionId, pendingChoice, replyChoice, skipChoice, send, regenerate, resend, onSendError }: GrillChoiceDeps) {
  const [grillMe, setGrillMe] = useState(false);
  const [grillScope, setGrillScope] = useState<GrillScope>({ kind: 'conversation' });
  const previousSession = useRef(sessionId);
  useEffect(() => {
    // 空入口创建出的第一间会话继承已选范围；切到其他会话才重置。
    if (previousSession.current != null && previousSession.current !== sessionId) {
      setGrillMe(false);
      setGrillScope({ kind: 'conversation' });
    }
    previousSession.current = sessionId;
  }, [sessionId]);
  const validScope = () => normalizeGrillScope(grillScope);
  const invalidScope = () => Promise.resolve({ ok: false, error: '请填写自定义学习主题（1–160 字）' });
  const sendWithGrill = (text: string, images?: Array<{ dataUrl: string; name?: string }>) => {
    if (!grillMe) return send(text, images, false);
    const scope = validScope();
    return scope ? send(text, images, true, scope) : invalidScope();
  };
  const regenerateWithGrill = () => {
    if (!regenerate) return Promise.resolve({ ok: false, error: '无法重新生成' });
    if (!grillMe) return regenerate();
    const scope = validScope();
    return scope ? regenerate(true, scope) : invalidScope();
  };
  const resendWithGrill = (text: string) => {
    if (!resend) return Promise.resolve({ ok: false, error: '无法编辑重发' });
    if (!grillMe) return resend(text);
    const scope = validScope();
    return scope ? resend(text, true, scope) : invalidScope();
  };

  /** 沉在消息流里的那张卡：只有带 `grillPhase` 的才算；普通 ask_choice 仍走浮层，两边不重复 */
  const grillCard = pendingChoice?.grillPhase ? pendingChoice : null;

  const replyGrill = (requestId: string, reply: ChoiceReplyPayload) => {
    const isPost = grillCard?.grillPhase === 'post';
    replyChoice(requestId, reply);
    if (!isPost) return;
    const label = reply.custom ?? grillCard?.options.find((o) => o.id === reply.optionId)?.label ?? '';
    if (!label.trim()) return;
    // v18.3：不再 void 吞错——send 被拒（busy/断连等）必须浮出来，否则就是「点了没反应」
    void sendWithGrill(label).then((r) => {
      if (!r.ok) onSendError?.(r.error ?? '发送失败，请重试');
    });
  };

  const skipGrill = () => {
    if (grillCard) skipChoice(grillCard.id);
  };

  /** 卡片渲染在**消息流末尾**：它是这一轮内容的一部分，跟着这轮滚走 */
  const grillNode = grillCard ? (
    <div className="chat-grill-card">
      <ChoiceCard request={grillCard} onReply={replyGrill} onDismiss={skipGrill} />
    </div>
  ) : null;

  return {
    /** 直接展开给 ChatComposer：模式开关与它的 setter */
    composerProps: { grillMe, setGrillMe, grillScope, setGrillScope },
    grillNode,
    /** 带模式标记地发一条提问（submit 用） */
    sendWithGrill,
    regenerate: regenerateWithGrill,
    resend: resendWithGrill,
  };
}
