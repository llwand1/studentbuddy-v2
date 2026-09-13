/**
 * Thinking —— 「思考中」等待态：三点弹跳 + 阶段感知状态行 + 已用时计时（v13 体验升级）。
 * 覆盖两段等待：① 发起后到首 token 落屏前（原生 AI 的空窗）；
 * ② 池中 AI（stream_mode='once'）的整个生成期——一次性回答没有逐字流（打字机平滑
 *   负责整块答案的匀速吐出），等待态就是它的「回答中」本体。
 * 状态行事件驱动（phaseStatus）：有工具在跑报真实动作，思考链在流报「深度思考中」，
 * 都没有才轮播中性短语——不撒谎。
 */
import { useEffect, useState } from 'react';
import { formatElapsed, phaseStatus, type PhaseStep } from './thinking-status';

export function Thinking({
  steps = [],
  reasoningLen = 0,
}: {
  steps?: PhaseStep[];
  /** 思考链已流出的字数（reasoning.length）：非零即「深度思考中」 */
  reasoningLen?: number;
}) {
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
          {phaseStatus(steps, reasoningLen, elapsed)}
          <span className="chat-typing-elapsed">{formatElapsed(elapsed)}</span>
        </span>
      </div>
    </div>
  );
}
