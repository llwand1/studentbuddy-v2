/**
 * ChatErrorBar —— 消息流里的错误条。
 *
 * 两类错误共用一条：流式中断（`chat-error` 帧：上游错／超时／已停止）与发送失败（HTTP 层）。
 * 只有前者给「↻ 重试」：那一问已经进了会话，重试＝对最后一问重新生成；
 * 发送失败的提问压根没进会话，重试没有对象——用户改一改再发即可（onRetry 不传）。
 */
export function ChatErrorBar({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="chat-error">
      <span>⚠ {text}</span>
      {onRetry && (
        <button type="button" className="chat-error-retry" onClick={onRetry}>
          ↻ 重试
        </button>
      )}
    </div>
  );
}
