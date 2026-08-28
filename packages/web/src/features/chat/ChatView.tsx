/**
 * ChatView — 对话视图：消息流 + composer（门控禁发 + 三态反馈，ADR-5）。
 */
import { useEffect, useRef, useState } from 'react';
import { useChatStream } from './useChatStream';
import { SendIcon, PlusIcon, QuizIcon, SearchIcon } from '../../components/icons';
import { QuizCard } from '../quiz/QuizCard';
import { Markdown } from './Markdown';
import { api } from '../../lib/api';
import './chat.css';

/** 工具中文名（新工具在 chat/tools.ts 注册后在此补一行） */
const TOOL_LABELS: Record<string, string> = { search_web: '联网搜索' };
const STEP_STATE: Record<'running' | 'done' | 'error', string> = {
  running: '进行中…',
  done: '完成',
  error: '失败',
};

export function ChatView({
  sessionId,
  onNewSession,
  onRoundDone,
}: {
  sessionId: string | null;
  onNewSession: () => void;
  onRoundDone?: () => void;
}) {
  const { messages, streamingText, steps, busy, ready, error, send, stop } = useChatStream(sessionId, onRoundDone);
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState('');
  const [quizzing, setQuizzing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, steps.length, streamingText]);

  const blocked = ready !== 'open' || busy;
  const statusHint =
    ready === 'reconnecting' ? '连接已断开，正在重连…' : ready === 'connecting' ? '正在建立连接…' : '';

  const submit = async () => {
    const text = input.trim();
    if (!text || blocked) return;
    setInput('');
    setSendError('');
    const r = await send(text);
    if (!r.ok && r.error) setSendError(r.error);
  };

  const quickQuiz = async () => {
    if (!sessionId || quizzing) return;
    const material = messages.slice(-8).map((m) => m.content).filter(Boolean).join('\n').slice(-4000);
    setQuizzing(true);
    setSendError('');
    try {
      const r = await api.request<{ error?: string }>('/api/quiz/generate', {
        method: 'POST',
        body: JSON.stringify({ topic: input.trim() || '根据当前对话内容出题', material: material || undefined, sessionId }),
      });
      if (r.error) setSendError(r.error);
      setInput('');
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    } finally {
      setQuizzing(false);
    }
  };

  if (!sessionId) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-card">
          <h2>开始学习</h2>
          <p>问概念、传资料、出一套题——学练析忆反馈都在这里。</p>
          <button className="chat-new-btn" onClick={onNewSession}>
            <PlusIcon /> 新对话
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <div className="chat-scroll">
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
            </div>
          ) : null,
        )}
        {steps.length > 0 && (
          <div className="chat-steps">
            {steps.map((s, i) => (
              <div key={i} className={`chat-step ${s.status}`}>
                <SearchIcon size={14} />
                <span className="chat-step-name">{TOOL_LABELS[s.tool] ?? s.tool}</span>
                <span className="chat-step-state">{STEP_STATE[s.status]}</span>
                {s.detail && <span className="chat-step-detail">{s.detail}</span>}
              </div>
            ))}
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
        <div ref={bottomRef} />
      </div>

      <div className="chat-composer-wrap">
        {statusHint && <div className="chat-conn-hint">{statusHint}</div>}
        <div className="chat-composer">
          <button
            className="chat-quiz-btn"
            title="基于当前对话一键出题（输入框文字作为主题）"
            disabled={!sessionId || quizzing || ready !== 'open'}
            onClick={() => void quickQuiz()}
          >
            <QuizIcon /> {quizzing ? '出题中…' : '出题'}
          </button>
          <textarea
            value={input}
            placeholder={blocked ? (busy ? '生成中…' : '连接未就绪…') : '问点什么（Enter 发送 / Shift+Enter 换行）'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
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
