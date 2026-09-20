/**
 * useQuizActions —— 出题动作域（ChatView 299/300 贴线时拆出，M3 起同时承载两类出题）：
 * ① 传统题组（quickQuiz，行为与拆出前逐字一致）；
 * ② 情景题（runScenario，M3，契约 docs/SCENARIO-SPEC.md §8）——生成走 REST，
 *    题卡经 SSE block 事件进消息流（useChatStream 分派），本 hook 只补错误与忙碌态。
 *
 * 纯状态编排：不发 toast、不碰路由；失败真因经 onError 交回 ChatView 统一显示。
 */
import { useCallback, useState } from 'react';
import type { AnswerStyle, QuizBlendReport, QuizImageReport, QuizPayload, QuizRef, ScenarioMixResult } from '@sb/shared';
import { api } from '../../lib/api';
import { blendNote, imageNote, refsList, searchNote, scenarioMixNote } from '../quiz/mix-report';

interface Opts {
  sessionId: string | null;
  /** 输入框当前文字（作为出题主题；空则用对话兜底主题） */
  input: string;
  /** 联网开关：只有传统题组接检索；情景题源自材料/主题本身（SPEC §9 已知边界） */
  online: boolean;
  /** 最近对话材料（ChatView 从 messages 取尾部拼装，本 hook 不持消息引用以免重渲染放大） */
  getMaterial: () => string;
  /** 出题成功后清空输入框（与拆出前 quickQuiz 的 setInput('') 同一处语义） */
  clearInput: () => void;
  onError: (msg: string) => void;
}

export function useQuizActions({ sessionId, input, online, getMaterial, clearInput, onError }: Opts) {
  const [quizzing, setQuizzing] = useState(false);
  const [scenarioing, setScenarioing] = useState(false);
  const [quizNote, setQuizNote] = useState('');
  /** 本次出题的参考来源清单（契约 QUIZ-SEARCH-SPEC §2.8）；没联网/没命中即空数组 */
  const [quizRefs, setQuizRefs] = useState<QuizRef[]>([]);

  /** 传统题组（行为与拆出前逐字一致；style 单次覆盖见 ANSWER-STYLE §4） */
  const runQuiz = useCallback(
    async (style?: AnswerStyle) => {
      if (!sessionId || quizzing) return;
      const material = getMaterial();
      setQuizzing(true);
      onError('');
      setQuizNote('');
      try {
        const r = await api.request<{
          error?: string;
          quiz?: QuizPayload;
          images?: QuizImageReport;
          scenarios?: ScenarioMixResult[];
          /** 合流报告（契约 QUIZ-BLEND-SPEC §3.4）：真题侧要/摘/缺；没配真题时 real 全 0，blendNote 返 null */
          blend?: QuizBlendReport;
        }>(
          '/api/quiz/generate',
          {
            method: 'POST',
            body: JSON.stringify({
              topic: input.trim() || '根据当前对话内容出题',
              material: material || undefined,
              sessionId,
              style,
              search: online,
            }),
          },
        );
        if (r.error) onError(r.error);
        // 题卡走 SSE 块进消息流；本行只补「图/联网/情景套数/真题报缺为什么不是足额」——有来源清单时改由清单承担告知（不说两遍）
        else {
          const found = refsList(r.images?.search);
          setQuizRefs(found);
          setQuizNote(
            [
              blendNote(r.blend, r.quiz?.questions),
              imageNote(r.images),
              found.length === 0 ? searchNote(r.images?.search) : null,
              scenarioMixNote(r.scenarios),
            ]
              .filter((s): s is string => s !== null)
              .join(' '),
          );
        }
        clearInput();
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setQuizzing(false);
      }
    },
    // 依赖刻意收窄：quizzing 是闸门不是依赖；input 每键入都变，进依赖会重建回调
    [sessionId, online, getMaterial, clearInput, onError],
  );

  /**
   * 情景题（M3）：sessionId 随请求下发——服务端把题卡推进聊天流（block 事件 + 历史落库）。
   * 成功时无补白要补：卡片本身就是全部反馈，失败真因在 502 error 里。
   */
  const runScenario = useCallback(async () => {
    if (!sessionId || scenarioing) return;
    setScenarioing(true);
    onError('');
    try {
      const r = await api.request<{ error?: string }>('/api/scenario/generate', {
        method: 'POST',
        body: JSON.stringify({
          topic: input.trim() || '根据当前对话内容出情景题',
          material: getMaterial() || undefined,
          sessionId,
        }),
      });
      if (r.error) onError(r.error);
      else clearInput();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setScenarioing(false);
    }
    // 依赖刻意收窄（同上）
  }, [sessionId, getMaterial, clearInput, onError]);

  /** 新一轮提问发起时清上一轮的补白与来源清单（它们是「那一轮」的产物，ChatView submit 调） */
  const resetRound = useCallback(() => {
    setQuizRefs([]);
    setQuizNote('');
  }, []);

  return { quizzing, scenarioing, quizNote, quizRefs, runQuiz, runScenario, resetRound };
}
