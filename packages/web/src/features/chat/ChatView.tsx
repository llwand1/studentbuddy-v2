/**
 * ChatView — 对话视图：消息流 + composer（门控禁发 + 三态反馈，ADR-5）。
 * 空会话（含还没选会话）统一渲染 Welcome 欢迎页，composer 始终在位。
 */
import { useEffect, useRef, useState } from 'react';
import { useChatStream } from './useChatStream';
import { useScrollAnchor } from './useScrollAnchor';
import { ThoughtPanel } from './ThoughtPanel';
import { ToolSteps } from './ToolSteps';
import { TaskPanel } from './TaskPanel';
import { MessageFoot } from './MessageFoot';
import { formatRoundMeta } from './chat-meta';
import { SendIcon, QuizIcon, CardsIcon, DownloadIcon } from '../../components/icons';
import { buildExportMarkdown, downloadText, exportFilename } from './chat-export';
import { QuizCard } from '../quiz/QuizCard';
import { mixSummary, imageNote } from '../quiz/mix-report';
import type { QuizImageReport, AnswerStyle } from '@sb/shared';
import { Markdown } from './Markdown';
import { Welcome } from './Welcome';
import { DocModeControl } from './DocModeControl';
import { AskStyleCard, useAskStyle } from './AskStyleCard';
import { api } from '../../lib/api';
import './chat.css';

export function ChatView({
  sessionId,
  sessionTitle,
  onNewSession,
  onRoundDone,
  onBusyChange,
}: {
  sessionId: string | null;
  /** 当前会话标题：导出文件与文档首行用它（App 持有会话列表，这里只收结果） */
  sessionTitle?: string;
  onNewSession: () => void;
  onRoundDone?: () => void;
  /** 生成状态上报：App 侧栏在生成中的会话项上显示「回复中」提示 */
  onBusyChange?: (busy: boolean, sessionId: string | null) => void;
}) {
  const { messages, streamingText, reasoning, steps, tasks, busy, ready, error, usage, elapsedMs, send, stop, regenerate } =
    useChatStream(sessionId, onRoundDone, onBusyChange);
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState('');
  const [quizzing, setQuizzing] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const [rememberMsg, setRememberMsg] = useState('');
  const [mixTip, setMixTip] = useState('');
  const [quizNote, setQuizNote] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 滚动锚定：贴底才跟随流式输出；离底时不打断用户上翻，改显示「回到底部」 */
  const { scrollRef, showJump, onScroll, jumpToBottom } = useScrollAnchor([messages.length, steps.length, tasks.length, streamingText]);

  /** 出题配比是全局设置（设置页改的），本视图只展示摘要；拉取失败静默——服务端仍按库内配比出题 */
  useEffect(() => {
    api.settings
      .quizMix()
      .then((r) => setMixTip(mixSummary(r.mix)))
      .catch(() => {});
  }, []);

  const blocked = ready !== 'open' || busy;
  const isEmpty = messages.length === 0 && steps.length === 0 && tasks.length === 0 && !streamingText;
  /** 轮次元信息只在收口后显示：生成过程中显示「已用 x tokens」会随流式跳动，且中途的数没有意义 */
  const roundMeta = busy ? '' : formatRoundMeta(usage, elapsedMs);
  /** 「重新生成」只给最后一条回答：对中间某条重生成的语义是分叉，本版不做（会牵扯历史改写） */
  const lastAssistantIdx = messages.reduce((acc, m, i) => (m.role === 'assistant' ? i : acc), -1);
  const doRegen = async (): Promise<void> => {
    const r = await regenerate();
    if (!r.ok && r.error) setSendError(r.error);
  };

  /** 导出当前对话为 Markdown：学习笔记的原料。格式与文件名规则在 chat-export.ts（纯函数已测） */
  const doExport = (): void => {
    if (messages.length === 0) return;
    const title = sessionTitle?.trim() || '对话';
    downloadText(exportFilename(title), buildExportMarkdown(title, messages));
  };
  const statusHint =
    sessionId === null ? '' : ready === 'reconnecting' ? '连接已断开，正在重连…' : ready === 'connecting' ? '正在建立连接…' : '';

  /** 建议卡：文字填进输入框可改再发（不自动发送）；还没会话时顺手开一个 */
  const pick = (text: string): void => {
    setInput(text);
    if (!sessionId) onNewSession();
    inputRef.current?.focus();
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || blocked) return;
    setInput('');
    setSendError('');
    const r = await send(text);
    if (!r.ok && r.error) setSendError(r.error);
  };

  /** 单次覆盖：style 只在「没配过 + 刚在选项卡上选完」这一条路上非空（契约 ANSWER-STYLE §4） */
  const quickQuiz = async (style?: AnswerStyle) => {
    if (!sessionId || quizzing) return;
    const material = messages.slice(-8).map((m) => m.content).filter(Boolean).join('\n').slice(-4000);
    setQuizzing(true);
    setSendError('');
    setQuizNote('');
    try {
      const r = await api.request<{ error?: string; images?: QuizImageReport }>('/api/quiz/generate', {
        method: 'POST',
        body: JSON.stringify({
          topic: input.trim() || '根据当前对话内容出题',
          material: material || undefined,
          sessionId,
          style,
        }),
      });
      if (r.error) setSendError(r.error);
      // 题卡走 SSE 块进消息流，本行只补「图为什么没出」这句话（没图不是失败，但也不能不说）
      else setQuizNote(imageNote(r.images) ?? '');
      setInput('');
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setQuizzing(false);
    }
  };

  /** 没配过回答方式时，点「出题」先就地展开选项卡问一次（契约 ANSWER-STYLE §4） */
  const ask = useAskStyle((style) => void quickQuiz(style));

  /** 忆域 v2：手动「存入记忆」——把最近对话内容交给 AI 抽取重要词条入库 */
  const rememberTerms = async () => {
    if (!sessionId || remembering) return;
    const material = messages.slice(-8).map((m) => m.content).filter(Boolean).join('\n').slice(-4000);
    if (!material.trim()) return;
    setRemembering(true);
    setRememberMsg('');
    try {
      const r = await api.terms.extract(material, sessionId);
      setRememberMsg(r.added > 0 ? `已存入 ${r.added} 个词条，后续回答会优先使用` : '这段对话没有值得记住的术语');
    } catch {
      setRememberMsg('存入失败，请稍后重试');
    } finally {
      setRemembering(false);
      window.setTimeout(() => setRememberMsg(''), 3000);
    }
  };

  return (
    <div className="chat-view">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {isEmpty && <Welcome onPick={pick} />}
        {messages.map((m, i) =>
          m.quizBlock ? (
            <QuizCard
              key={i}
              title={m.quizBlock.quiz.title ?? '练习'}
              questions={m.quizBlock.quiz.questions}
              quizId={m.quizBlock.quizId}
              onAnswer={(qi, correct) => {
                if (m.quizBlock?.quizId) {
                  void api.request('/api/quiz/stats/record', {
                    method: 'POST',
                    body: JSON.stringify({ quizId: m.quizBlock.quizId, questionIndex: qi, correct }),
                  });
                }
              }}
            />
          ) : m.content ? (
            <div key={i} className={m.role === 'user' ? 'chat-row user' : 'chat-row'}>
              {m.role === 'user' ? (
                <div className="chat-bubble user">{m.content}</div>
              ) : (
                <div className="chat-bubble md">
                  <Markdown text={m.content} />
                </div>
              )}
              <MessageFoot
                ts={m.ts}
                content={m.content}
                canRegen={m.role === 'assistant' && i === lastAssistantIdx}
                regenDisabled={busy}
                onRegen={() => void doRegen()}
              />
            </div>
          ) : null,
        )}
        {reasoning && <ThoughtPanel text={reasoning} streaming={busy} />}
        {tasks.length > 0 && <TaskPanel items={tasks} streaming={busy} />}
        <ToolSteps steps={steps} />
        {/* 回复中动画：发起后到首 token 落屏前（含纯工具执行期）的空窗，三点弹跳补位；
            正文一开始流就退场（气泡内已有闪烁光标），不与内容抢屏 */}
        {busy && !streamingText && (
          <div className="chat-row">
            <div className="chat-bubble chat-typing" role="status" aria-label="回复中">
              <span className="chat-typing-dot" />
              <span className="chat-typing-dot" />
              <span className="chat-typing-dot" />
            </div>
          </div>
        )}
        {streamingText && (
          <div className="chat-row">
            <div className="chat-bubble md streaming">
              <Markdown text={streamingText} streaming />
              <span className="chat-caret" />
            </div>
          </div>
        )}
        {(error || sendError) && <div className="chat-error">⚠ {error || sendError}</div>}
        {rememberMsg && <div className="chat-remember-msg">{rememberMsg}</div>}
        {roundMeta && <div className="chat-round-meta">{roundMeta}</div>}
      </div>

      <div className="chat-composer-wrap">
        {showJump && (
          <button type="button" className="chat-jump" onClick={jumpToBottom}>
            ↓ 回到最新
          </button>
        )}
        {statusHint && <div className="chat-conn-hint">{statusHint}</div>}
        {mixTip && sessionId && (
          <div className="chat-quiz-mix">
            出题配比：{mixTip}
            {ask.summary && <>｜回答方式：{ask.summary}</>}
            <span className="chat-quiz-mix-sep">·</span>
            设置页可改
          </div>
        )}
        {ask.hint && <div className="ask-style-hint">{ask.hint}</div>}
        {ask.card && <AskStyleCard {...ask.card} busy={quizzing} />}
        <DocModeControl sessionId={sessionId} blocked={ready !== 'open'} />
        {quizNote && <div className="chat-quiz-mix">{quizNote}</div>}
        <div className="chat-composer">
          <button
            className="chat-quiz-btn"
            title={
              mixTip
                ? `基于当前对话一键出题，按配比出：${mixTip}（设置页可改）`
                : '基于当前对话一键出题（输入框文字作为主题）'
            }
            disabled={!sessionId || quizzing || ready !== 'open'}
            onClick={() => ask.tap()}
          >
            <QuizIcon /> {quizzing ? '出题中…' : '出题'}
          </button>
          <button
            className="chat-quiz-btn"
            title="把最近对话中的重要术语存入词条库，后续回答优先使用"
            disabled={!sessionId || remembering || ready !== 'open'}
            onClick={() => void rememberTerms()}
          >
            <CardsIcon /> {remembering ? '收集中…' : '存入记忆'}
          </button>
          <button
            className="chat-quiz-btn"
            title="把当前对话导出为 Markdown（含时间与角色，可直接贴进笔记）"
            disabled={!sessionId || messages.length === 0}
            onClick={doExport}
          >
            <DownloadIcon /> 导出
          </button>
          <textarea
            ref={inputRef}
            value={input}
            placeholder={
              sessionId === null
                ? '点一张建议卡先起个头（会自动开新会话）'
                : blocked
                  ? busy
                    ? '生成中…'
                    : '连接未就绪…'
                  : '问点什么（Enter 发送 / Shift+Enter 换行）'
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 输入法组字期间的回车是「选词确认」而不是「发送」：没有这道判断，
              // 中文用户打完拼音按回车上屏的瞬间就会把半成品发出去（keydown 仍会触发）
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
          />
          {busy ? (
            <button className="chat-stop" onClick={() => void stop()} title="停止生成">
              ■
            </button>
          ) : (
            <button className="chat-send" disabled={!input.trim() || blocked} onClick={() => void submit()} title="发送">
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
