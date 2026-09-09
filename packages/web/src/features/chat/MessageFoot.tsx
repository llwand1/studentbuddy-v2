/**
 * MessageFoot —— 单条消息下方的时间戳 + 操作（复制 / 重新生成）。
 * 抽出来是为了守 web 组件 ≤300 行的红线（ChatView 已 267 行），也因为这两个动作
 * 各自的失败形态（剪贴板不可用、生成中禁点）不该塞进消息渲染的主干里。
 */
import { useState } from 'react';
import { formatMsgTime } from './chat-meta';
import './chat-extras.css';

export function MessageFoot({
  ts,
  content,
  canRegen = false,
  regenDisabled = false,
  onRegen,
}: {
  ts?: string;
  content: string;
  canRegen?: boolean;
  regenDisabled?: boolean;
  onRegen?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const time = formatMsgTime(ts);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用（非安全上下文/无权限）：静默，正文仍可手动选取复制 */
    }
  };

  return (
    <div className="msg-foot">
      {time && <span className="msg-time">{time}</span>}
      <button type="button" className="msg-act" onClick={() => void copy()}>
        {copied ? '已复制' : '复制'}
      </button>
      {canRegen && (
        <button type="button" className="msg-act" disabled={regenDisabled} onClick={onRegen}>
          重新生成
        </button>
      )}
    </div>
  );
}
