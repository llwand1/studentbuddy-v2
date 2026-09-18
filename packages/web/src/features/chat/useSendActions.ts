/**
 * useSendActions — 「发送 / 重跑 / 停止」这组动作（2026-09-14 从 `useChatStream` 拆出）。
 *
 * 为什么拆：`useChatStream` 加进方案选择框的事件转发后触到 400 行红线（AGENTS：`.ts` ≤400）。
 * 而 send / rerun 这组动作与「流式呈现」本就是两个关注点——它们只负责发请求与撤屏口径，
 * 完全不认识 token / step / tasks。拆开后「改呈现」与「改发送」互不打扰。
 *
 * 边界：本 hook 不解析任何 SSE 事件、不持有流式状态；一切状态由调用方提供。
 * 与 useChatStream 之间只有 `StreamMessage` 一个 **type-only** 依赖，不构成运行时循环。
 */
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { SseReadyState } from '../../lib/sse-client';
import { api } from '../../lib/api';
import type { StreamMessage } from './useChatStream';

export interface SendActionsDeps {
  sessionId: string | null;
  ready: SseReadyState;
  busy: boolean;
  /** 新一轮公共前置（清残留 + 计时）：发送与重跑都要先走 */
  beginRound: () => void;
  setError: (msg: string) => void;
  setBusy: (v: boolean) => void;
  setMessages: Dispatch<SetStateAction<StreamMessage[]>>;
  /** 历史是否已落定：未落定前禁发，否则 messages 响应后到会把刚发的用户消息整表覆盖掉 */
  historyLoadedRef: { current: boolean };
  /**
   * v18.4 联网开关（会话级，ChatView 持有）：随本轮出站。发送与重跑**同口径**——
   * 用户开着联网点「重新生成」，期望也是联网重跑，不该两样。
   */
  online?: boolean;
}

export function useSendActions(deps: SendActionsDeps) {
  const { sessionId, ready, busy, beginRound, setError, setBusy, setMessages, historyLoadedRef, online } = deps;

  /** 发送：SSE 未就绪时拒绝并提示（修 F1 竞态——绝不静默吞） */
  const send = useCallback(
    async (
      text: string,
      images?: Array<{ dataUrl: string; name?: string }>,
      grillMe?: boolean,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!sessionId) return { ok: false, error: '无会话' };
      if (ready !== 'open') return { ok: false, error: `连接${ready === 'reconnecting' ? '重连中' : '建立中'}，稍候再发` };
      if (busy) return { ok: false, error: '生成中，请先停止' };
      if (!historyLoadedRef.current) return { ok: false, error: '历史加载中，稍候再发' };
      setError('');
      beginRound();
      // 乐观渲染用户气泡（含图片缩略图）；图片随消息落库，历史回显走 /messages 的 images 列
      setMessages((ms) => [
        ...ms,
        { role: 'user', content: text, ts: new Date().toISOString(), ...(images && images.length > 0 ? { images } : {}) },
      ]);
      try {
        await api.chat.send(sessionId, text, images, grillMe, online);
        setBusy(true);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return { ok: false, error: msg };
      }
    },
    [sessionId, ready, busy, beginRound, setError, setBusy, setMessages, historyLoadedRef, online],
  );

  /**
   * 重跑类动作公共体：regenerate（原样重跑）与 resend（编辑重发）只有两处不同——
   * 服务端端点、以及「最后一条提问是否就地换文案」。撤屏口径完全一致：
   * 只保留最后一条提问及其之前（resend 再把该提问内容替换成新文案），否则新回答会接在旧回答后面。
   */
  const rerun = useCallback(
    async (mode: 'regen' | 'resend', text?: string): Promise<{ ok: boolean; error?: string }> => {
      if (!sessionId) return { ok: false, error: '无会话' };
      if (ready !== 'open')
        return { ok: false, error: `连接${ready === 'reconnecting' ? '重连中' : '建立中'}，稍候再试` };
      if (busy) return { ok: false, error: '生成中，请先停止' };
      setError('');
      beginRound();
      setMessages((ms) => {
        const lastUser = ms.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
        if (lastUser < 0) return ms;
        const kept = ms.slice(0, lastUser);
        const last = ms[lastUser];
        // resend：提问内容就地替换（服务端 planResend 同一口径：更新内容、作废其后产物）
        const edited = mode === 'resend' && last ? ({ ...last, content: text } as StreamMessage) : last;
        return edited ? [...kept, edited] : kept;
      });
      try {
        if (mode === 'resend') await api.chat.resend(sessionId, text ?? '', online);
        else await api.chat.regenerate(sessionId, online);
        setBusy(true);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return { ok: false, error: msg };
      }
    },
    [sessionId, ready, busy, beginRound, setError, setBusy, setMessages, online],
  );

  /** 重新生成：服务端已把最后一条提问之后的产物删掉（含工具轮与中止半截）后原样重跑 */
  const regenerate = useCallback(() => rerun('regen'), [rerun]);
  /** 编辑重发（v13 体验升级）：把最后一条提问改成新文案后重跑（只挂最后一条提问，改写更早的是分叉，不做） */
  const resend = useCallback((text: string) => rerun('resend', text), [rerun]);

  /** 停止生成：服务端 abort 桥接至底层 fetch；挂起的方案选择由服务端连带作废（SPEC §5 逃生口①） */
  const stop = useCallback(async () => {
    if (sessionId) await api.chat.abort(sessionId).catch(() => undefined);
  }, [sessionId]);

  return { send, stop, regenerate, resend };
}
