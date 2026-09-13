/**
 * Thinking —— 「思考中」等待态：三点弹跳 + 轮播短语 + 已用时计时（v13 体验升级）。
 * 覆盖两段等待：① 发起后到首 token 落屏前（原生 AI 的空窗）；
 * ② 池中 AI（stream_mode='once'）的整个生成期——一次性回答只有等待和整块上屏两个形态，
 *   这块 UI 就是它的「回答中」本体。短语池口径见 thinking-status.ts（纯函数已测）。
 */
import { useEffect, useState } from 'react';
import { formatElapsed, thinkingPhrase } from './thinking-status';

export function Thinking() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Date.now() - start), 200);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="chat-row">
      <div className="chat-bubble chat-typing" role="status" aria-label="回复中">
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
        <span className="chat-typing-dot" />
        <span className="chat-typing-status">
          {thinkingPhrase(elapsed)}
          <span className="chat-typing-elapsed">{formatElapsed(elapsed)}</span>
        </span>
      </div>
    </div>
  );
}
