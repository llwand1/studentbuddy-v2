/**
 * ThoughtPanel —— 思考过程（reasoning 事件）折叠面板。
 * 为什么单开一个组件：ChatView 已 254 行、web 红线 300，塞进去必破线；
 * 且「思考」有自己的展开态，与消息流无关，拆开各自好改。
 *
 * 渲染纪律：reasoning 只作纯文本展示（pre-wrap），**不做 Markdown 解析**——
 * 它是模型草稿，可能含半截围栏，按 Markdown 渲染会出现闪烁的畸形块。
 *
 * 形态（2026-09-12 对齐主流）：默认折叠（主流的「思考」都是先收着，用户想看才展开），
 * 标题带**内容体量**摘要——用字数而不是耗时：耗时没有随消息落库，历史回放时拿不到，
 * 会出现「本轮显示 12 秒、刷新后不显示」的口径分叉；字数是文本自带属性，两边恒一致。
 */
import { useState } from 'react';
import './chat-extras.css';

/** 体量摘要：1k 以上折成 x.xk，避免一长串数字抢视线 */
function sizeLabel(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k 字` : `${n} 字`;
}

export function ThoughtPanel({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;

  return (
    <div className="chat-thought">
      <button type="button" className="chat-thought-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={streaming ? 'chat-thought-dot live' : 'chat-thought-dot'} />
        <span className="chat-thought-title">{streaming ? '正在思考…' : '思考过程'}</span>
        {/* 流式中字数每帧都在变，跳动的数字是噪音；收口后才给体量摘要 */}
        {!streaming && <span className="chat-thought-meta">{sizeLabel(text.length)}</span>}
        <span className="chat-thought-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="chat-thought-body">{text}</div>}
    </div>
  );
}
