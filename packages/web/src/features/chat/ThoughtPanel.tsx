/**
 * ThoughtPanel —— 思考过程（reasoning 事件）折叠面板。
 * 为什么单开一个组件：ChatView 已 254 行、web 红线 300，塞进去必破线；
 * 且「思考」有自己的展开态，与消息流无关，拆开各自好改。
 *
 * 渲染纪律：reasoning 只作纯文本展示（pre-wrap），**不做 Markdown 解析**——
 * 它是模型草稿，可能含半截围栏，按 Markdown 渲染会出现闪烁的畸形块。
 *
 * 形态：默认折叠（主流的先收着，用户想看才展开，同 OpenWebUI `expandDetails:false`）。
 *
 * ★ 2026-09-19 P1 **撤销 2026-09-12「用字数不用耗时」决策**（作废登记，不静默删除）：
 *   当时的前提「耗时没有随消息落库，历史回放拿不到」已被迁移 v32 的 `thinking_ms` 列解决
 *   （服务端测差值 + done 帧携带，线上与库内同源——口径见 `TOOL-ECOSYSTEM-SPEC.md` §4.7）。
 *   标题改为文案三态：`深度思考中…`（流式）→ `已深度思考（用时 4.2s）`（`formatDuration` 三档：
 *   `823ms`／`4.2s`／`1min12s`）→ `已深度思考`（耗时缺失，
 *   **禁显示「0 秒」**——老消息没测过 ≠ 想了 0 秒）。字数降级为副信息保留（体量仍然有用）。
 */
import { useState } from 'react';
import { formatDuration } from './thinking-status';
import './chat-extras.css';

/** 体量摘要：1k 以上折成 x.xk，避免一长串数字抢视线 */
function sizeLabel(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k 字` : `${n} 字`;
}

export function ThoughtPanel({ text, streaming, ms }: { text: string; streaming: boolean; ms?: number }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const title = streaming ? '深度思考中…' : ms != null ? `已深度思考（用时 ${formatDuration(ms)}）` : '已深度思考';

  return (
    <div className="chat-thought">
      <button type="button" className="chat-thought-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={streaming ? 'chat-thought-dot live' : 'chat-thought-dot'} />
        <span className="chat-thought-title">{title}</span>
        {/* 流式中标题在变、字数每帧也在变，跳动的数字是噪音；收口后才给副信息 */}
        {!streaming && <span className="chat-thought-meta">{sizeLabel(text.length)}</span>}
        <span className="chat-thought-toggle">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="chat-thought-body">{text}</div>}
    </div>
  );
}
