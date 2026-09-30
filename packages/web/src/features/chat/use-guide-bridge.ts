/**
 * use-guide-bridge —— ChatView 这一侧接入引路灯的全部接线（契约 `docs/GUIDE-SPEC.md` §3 / §8）。
 * 拆成独立 hook，是因为 ChatView 贴着 320 行红线：接入只留一行调用。
 *
 * 三件事：
 * ① **上报现场**：哪个会话、几轮、空不空、忙不忙——提灯据此判阶段、决定何时亮灯；卸载（切去别的页）即撤销。
 * ② **登记能力**：追问 / 出题 / 情景题 / 存入记忆 / 找视频。可用条件与「+」菜单里同名条目的 `disabled` 逻辑**同口径**
 *    （没会话、生成中、连接没就绪都不可用），所以推荐永远不会落在一个点了没反应的动作上。
 * ③ **取信开聊**：提灯的「随机话题」把话放进信箱；这里在「没选会话」或「停在空白会话」且不忙时取走，
 *    交给 ChatView 既有的 `fire`（⇒ `useQuickStart`：开会话 → 等 SSE 就绪 → 自动发出）。
 */
import { useEffect, useRef } from 'react';
import { videoQueryFromText } from '@sb/shared';
import type { StreamMessage } from './useChatStream';
import { openVideoRoute } from '../../lib/video-route-store';
import { setGuideChat, takeGuideMail, useGuideLive } from '../guide/guide-store';
import { useGuideCaps } from '../guide/use-guide-cap';

export interface GuideBridgeArgs {
  sessionId: string | null;
  messages: readonly StreamMessage[];
  /** 会话里什么都没有（ChatView 的 isEmpty） */
  empty: boolean;
  /** 不能动：生成中 / 正在开会话 / 连接没就绪（ChatView 的 blocked） */
  blocked: boolean;
  quizzing: boolean;
  scenarioing: boolean;
  remembering: boolean;
  /** 发出一问的公共路径（ChatView 的 fire：清错、焦点回框、交给 quick.fire） */
  fire: (text: string) => void;
  startQuiz: () => void;
  startScenario: () => void;
  remember: () => void;
}

/** 最近一条真回答（跳过题卡 / 情景题登记行与纯工具轮）：「找视频」的种子取它 */
function lastAnswerOf(messages: readonly StreamMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'assistant' && !m.quizBlock && !m.scenarioBlock && m.content.trim()) return m.content;
  }
  return '';
}

export function useGuideBridge(a: GuideBridgeArgs): void {
  const ref = useRef(a);
  ref.current = a;
  const live = useGuideLive();
  const rounds = a.messages.filter((m) => m.role === 'user').length;
  const answer = lastAnswerOf(a.messages);

  // ① 上报现场（内容没变 store 不通知）；卸载撤销
  useEffect(() => {
    setGuideChat({ sessionId: a.sessionId, rounds, empty: a.empty, busy: a.blocked });
  }, [a.sessionId, rounds, a.empty, a.blocked]);
  useEffect(() => () => setGuideChat(null), []);

  // ② 登记能力：条件与「+」菜单同口径
  const talked = a.sessionId !== null && rounds > 0 && !a.blocked;
  useGuideCaps({
    'chat.ask': talked ? (text) => text && ref.current.fire(text) : null,
    'quiz.start': talked && !a.quizzing ? () => ref.current.startQuiz() : null,
    'quiz.scenario': talked && !a.scenarioing ? () => ref.current.startScenario() : null,
    'chat.remember': talked && !a.remembering ? () => ref.current.remember() : null,
    'chat.videos':
      a.sessionId !== null && !a.blocked && answer
        ? () => {
            const sid = ref.current.sessionId;
            if (sid) openVideoRoute(sid, videoQueryFromText(lastAnswerOf(ref.current.messages)));
          }
        : null,
  });

  // ③ 取信开聊：没选会话（开新会话走 quick 的暂存路径）或停在空白会话里（就地发），且不忙
  useEffect(() => {
    if (live.mail === null || a.blocked) return;
    if (a.sessionId !== null && !a.empty) return;
    const text = takeGuideMail();
    if (text) ref.current.fire(text);
  }, [live.mail, a.blocked, a.sessionId, a.empty]);
}
