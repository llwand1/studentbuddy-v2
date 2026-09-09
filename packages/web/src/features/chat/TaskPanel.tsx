/**
 * TaskPanel —— 任务清单进度面板（标准 CoT）。
 * 数据源：SSE tasks 事件（模型经 update_tasks 工具全量覆盖式更新）。
 * 语义：整表替换，不做本地合并——面板永远反映模型最后一次声明的状态；
 * 生成中显示 spinner，done 后保留可回看（与 reasoning / steps 同策略）。
 */
import type { TaskItem } from './useChatStream';
import './chat-extras.css';

export function TaskPanel({ items, streaming }: { items: TaskItem[]; streaming: boolean }) {
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === 'done').length;
  const allDone = done === items.length;

  return (
    <div className="chat-tasks">
      <div className="chat-tasks-head">
        <span className={`chat-tasks-dot${streaming && !allDone ? ' live' : ''}`} />
        <span className="chat-tasks-title">{allDone ? '任务清单' : '正在执行'}</span>
        <span className="chat-tasks-progress">
          {done}/{items.length}
        </span>
      </div>
      <ul className="chat-tasks-list">
        {items.map((it, i) => (
          <li key={i} className={`chat-task ${it.status}`}>
            <span className="chat-task-mark" aria-hidden>
              {it.status === 'done' ? '✓' : ''}
            </span>
            <span className="chat-task-text">{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
