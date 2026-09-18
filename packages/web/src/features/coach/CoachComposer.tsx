/**
 * CoachComposer — 抽屉底部的输入区（督促对话的入口）。
 *
 * 三条取舍：
 *  ① **快捷指令放在输入框上方**（而不是藏进菜单）：小窗里最常见的三句话是固定的
 *     （今天怎么排 / 为什么是现在 / 我进步了吗），让它们一次点击可达，等于省掉大部分打字；
 *  ② **发送即打断上一轮**（服务端同一条流只留最新一轮）：督促场景里"改口"是常态，
 *     排队反而让人等一句已经不想听的话；
 *  ③ Enter 发送、Shift+Enter 换行——与他人对话习惯一致，不发明新交互。
 */
import { useState } from 'react';
import { COACH_QUICK_ACTIONS } from '@sb/shared';
import { SendIcon, StopIcon } from '../../components/icons';

export function CoachComposer({
  busy,
  onSend,
  onStop,
}: {
  /** 服务端正在生成这一轮回复 */
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    onSend(t);
  };

  return (
    <div className="coach-composer">
      <div className="coach-quick">
        {COACH_QUICK_ACTIONS.map((a) => (
          <button key={a.key} className="coach-quick-btn" disabled={busy} onClick={() => onSend(a.prompt)}>
            {a.label}
          </button>
        ))}
      </div>
      <div className="coach-input-row">
        <textarea
          className="coach-input"
          rows={2}
          value={text}
          placeholder="问一句，或让它讲讲某个词条…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button className="coach-send stop" onClick={onStop} title="停止这一轮">
            <StopIcon size={15} />
          </button>
        ) : (
          <button className="coach-send" onClick={submit} disabled={!text.trim()} title="发送">
            <SendIcon size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
