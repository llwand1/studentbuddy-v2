/**
 * ThoughtPanel —— 思考过程（reasoning 事件）折叠面板。
 * 为什么单开一个组件：ChatView 已 254 行、web 红线 300，塞进去必破线；
 * 且「思考」有自己的展开态，与消息流无关，拆开各自好改。
 *
 * 渲染纪律：reasoning 只作纯文本展示（pre-wrap），**不做 Markdown 解析**——
 * 它是模型草稿，可能含半截围栏，按 Markdown 渲染会出现闪烁的畸形块。
 */
import { useState } from 'react';
import './chat-extras.css';

export function ThoughtPanel({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  return (
    <div className="chat-thought">
      <button type="button" className="chat-thought-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={streaming ? 'chat-thought-dot live' : 'chat-thought-dot'} />
        <span className="chat-thought-title">{streaming ? '正在思考…' : '思考过程'}</span>
        <span className="chat-thought-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="chat-thought-body">{text}</div>}
    </div>
  );
}
