/**
 * ChatView — 对话视图：消息流 + composer（门控禁发 + 三态反馈，ADR-5）。
 * 空会话（含还没选会话）统一渲染 Welcome 欢迎页，composer 始终在位。
 *
 * 2026-09-13 改版（老板口述两处，两处都是「位置错了」而不是「功能缺了」）：
 * ① 输入框那排功能键（出题/联网/存入记忆/导出/文档模式）收进 `ChatComposer` 的「+」菜单；
 * ② 出题的**联网参考来源清单**从「常驻输入框上方」移进**消息流末尾**——它是**本轮的产物**，
 *    该跟这轮对话一起滚走、下一轮提问即清空（见 `submit`）；钉在输入框上方会一直留着、看着像全局状态（老板实测指出）。
 *
 * 本文件只留「消息流 + 编排」；输入区整体在 `ChatComposer.tsx`（ChatView 曾贴 300 行门禁）。
 */
import { useEffect, useRef, useState } from 'react';
import { useChatStream } from './useChatStream';
import { useScrollAnchor } from './useScrollAnchor';
import { ThoughtPanel } from './ThoughtPanel';
import { ToolSteps } from './ToolSteps';
import { TaskPanel } from './TaskPanel';
import { MessageRow } from './MessageRow';
import { formatRoundMeta } from './chat-meta';
import { buildExportMarkdown, downloadText, exportFilename } from './chat-export';
import { mixTipText } from '../quiz/bank-view';
import { useQuizActions } from './use-quiz-actions';
import { RefList } from '../quiz/RefList';

import { Markdown } from './Markdown';
import { Welcome } from './Welcome';
import { Thinking } from './Thinking';
import { ChatComposer } from './ChatComposer';
import { useGrillChoice } from './useGrillChoice';
import { useDocMode } from './useDocMode';
import { useAskStyle } from './AskStyleCard';
import { api } from '../../lib/api';
import { useAutoResize } from './useAutoResize';
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
  /** v18.4 联网开关：默认开（与题库页同件同默认，契约 QUIZ-SEARCH §3）。对话与出题共用这一份 */
  const [online, setOnline] = useState(true);
  const {
    messages,
    streamingText,
    reasoning,
    steps,
    tasks,
    busy,
    ready,
    error,
    usage,
    elapsedMs,
    startedAtMs,
    send,
    stop,
    regenerate,
    resend,
    pendingChoice,
    replyChoice,
    dismissChoice,
    skipChoice,
    pendingConfirm,
    confirmNowMs,
    replyConfirm,
    dismissConfirm,
  } = useChatStream(sessionId, onRoundDone, onBusyChange, online);
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState('');
  // v18.3：grill 收尾卡点选后 send 失败要浮出来（此前 void 吞掉 {ok:false}＝点了没反应）
  const { composerProps, grillNode, sendWithGrill } = useGrillChoice({ pendingChoice, replyChoice, skipChoice, send, onSendError: setSendError });
  /** v17 看图：待发送的图片附件（base64 dataURL）。随会话切换清空，避免串台 */
  const [attachments, setAttachments] = useState<Array<{ dataUrl: string; name?: string }>>([]);
  const [remembering, setRemembering] = useState(false);
  const [rememberMsg, setRememberMsg] = useState('');
  const [mixTip, setMixTip] = useState('');
  /** 出题动作域（传统题组 + 情景题，v0.2.37 从本文件拆出——本文件贴 300 行红线） */
  const quiz = useQuizActions({
    sessionId,
    input,
    online,
    getMaterial: () => messages.slice(-8).map((m) => m.content).filter(Boolean).join('\n').slice(-4000),
    clearInput: () => setInput(''),
    onError: setSendError,
  });
  /** 文档模式载入面板是否展开：触发器在「+」菜单里，面板与 pill 在 composer 上方 */
  const [docOpen, setDocOpen] = useState(false);
  /** 文档模式状态：与菜单里的触发器共用同一份（载入成功即收面板，失败留着让人看见错） */
  const doc = useDocMode(sessionId, () => setDocOpen(false));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 滚动锚定：贴底才跟随流式输出；离底时不打断用户上翻，改显示「回到底部」。
      来源清单也算锚：它随本轮落屏，贴底时该被带进视野 */
  const { scrollRef, showJump, onScroll, jumpToBottom } = useScrollAnchor([
    messages.length,
    steps.length,
    tasks.length,
    streamingText,
    quiz.quizRefs.length,
  ]);
  /** 输入框随内容自增高：高度写进 CSS 变量 --ta-h（chat.css），上限 200px 后内滚 */
  useAutoResize(inputRef, input);

  /** 出题配比是全局设置（设置页改的），本视图只展示摘要；拉取失败静默——服务端仍按库内配比出题 */
  useEffect(() => {
    Promise.all([api.settings.quizMix(), api.settings.quizSourceMix()])
      .then(([a, b]) => setMixTip(mixTipText(a.mix, b.mix)))
      .catch(() => {});
  }, []);

  /** 切会话收起载入面板：面板里可能还留着上一会话没提交的粘贴内容，串台比收起更糟 */
  useEffect(() => {
    setDocOpen(false);
    setAttachments([]);
  }, [sessionId]);

  const blocked = ready !== 'open' || busy;
  const isEmpty = messages.length === 0 && steps.length === 0 && tasks.length === 0 && !streamingText;
  /** 轮次元信息只在收口后显示：生成过程中显示「已用 x tokens」会随流式跳动，且中途的数没有意义 */
  const roundMeta = busy ? '' : formatRoundMeta(usage, elapsedMs);
  /** 「重新生成」只给最后一条回答：对中间某条重生成的语义是分叉，本版不做（会牵扯历史改写） */
  const lastAssistantIdx = messages.reduce((acc, m, i) => (m.role === 'assistant' ? i : acc), -1);
  /** 「编辑重发」同理只给最后一条提问（v13）：编辑更早的提问=改写历史分叉 */
  const lastUserIdx = messages.reduce((acc, m, i) => (m.role === 'user' ? i : acc), -1);
  const doRegen = async (): Promise<void> => {
    const r = await regenerate();
    if (!r.ok && r.error) setSendError(r.error);
  };
  const doEdit = async (text: string): Promise<void> => {
    const r = await resend(text);
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
    const imgs = attachments;
    // 允许「纯图片」提问（无文字也有图）；文字与图都没有才拦截
    if ((!text && imgs.length === 0) || blocked) return;
    setInput('');
    setAttachments([]);
    setSendError('');
    // 上一轮的来源清单随本轮提问退场：它是**那一轮**的产物，留着会让人以为这一轮也查了网
    quiz.resetRound();
    const r = await sendWithGrill(text, imgs.length > 0 ? imgs : undefined);
    if (!r.ok && r.error) setSendError(r.error);
  };

  /** 没配过回答方式时，点「出题」先就地展开选项卡问一次（契约 ANSWER-STYLE §4） */
  const ask = useAskStyle((style) => void quiz.runQuiz(style));

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
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite" aria-busy={busy}>
        {isEmpty && <Welcome onPick={pick} />}
        {messages.map((m, i) => (
          <MessageRow
            key={i}
            m={m}
            canRegen={m.role === 'assistant' && i === lastAssistantIdx}
            regenDisabled={busy}
            onRegen={() => void doRegen()}
            canEdit={m.role === 'user' && i === lastUserIdx}
            editDisabled={busy}
            onEdit={(text) => void doEdit(text)}
          />
        ))}
        {reasoning && <ThoughtPanel text={reasoning} streaming={busy} />}
        {tasks.length > 0 && <TaskPanel items={tasks} streaming={busy} />}
        {/* 当前轮的工具步骤：流式中挂在这里（回答还没落成消息），done 时归并进上面对应的消息里 */}
        <ToolSteps steps={steps} />
        {/* 回复中等待态（v13）：三点弹跳 + 阶段感知状态行（有工具跑报真实动作）+ 已用时。
            覆盖发起后到首 token 落屏前的空窗（含纯工具执行期），以及池中 AI
            （stream_mode='once'）的整个生成期——它没有逐字流，等待态就是回答中的本体 */}
        {busy && !streamingText && <Thinking steps={steps} reasoningLen={reasoning.length} startedAtMs={startedAtMs} />}
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
        {/* 本轮出题的补白与来源清单：都进消息流，跟这一轮一起滚走（改版前钉在输入框上方，
            会一直留着像全局状态）。有来源清单时由清单承担告知，`quizNote` 只留「图/联网没成」 */}
        {quiz.quizNote && <div className="chat-quiz-mix">{quiz.quizNote}</div>}
        <RefList refs={quiz.quizRefs} />
        {roundMeta && <div className="chat-round-meta">{roundMeta}</div>}
        {grillNode}
      </div>

      <ChatComposer
        sessionId={sessionId}
        blocked={blocked}
        busy={busy}
        input={input}
        setInput={setInput}
        inputRef={inputRef}
        attachments={attachments}
        setAttachments={setAttachments}
        {...composerProps}
        onSubmit={() => void submit()}
        onStop={() => void stop()}
        quizzing={quiz.quizzing}
        onQuiz={() => ask.tap()}
        scenarioing={quiz.scenarioing}
        onScenario={() => void quiz.runScenario()}
        online={online}
        setOnline={setOnline}
        remembering={remembering}
        onRemember={() => void rememberTerms()}
        onExport={doExport}
        canExport={messages.length > 0}
        doc={doc}
        docOpen={docOpen}
        setDocOpen={setDocOpen}
        showJump={showJump}
        onJump={jumpToBottom}
        statusHint={statusHint}
        mixTip={mixTip}
        askSummary={ask.summary}
        askHint={ask.hint}
        askCard={ask.card}
        choiceCard={pendingChoice}
        confirmCard={pendingConfirm}
        confirmNowMs={confirmNowMs}
        onConfirmReply={replyConfirm}
        onDismissConfirm={dismissConfirm}
        onChoiceReply={replyChoice}
        onDismissChoice={dismissChoice}
      />
    </div>
  );
}
