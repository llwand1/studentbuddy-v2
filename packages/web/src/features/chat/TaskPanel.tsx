/**
 * TaskPanel —— 任务清单进度面板（标准 CoT）。
 * 数据源：SSE tasks 事件（模型经 update_tasks 维护）。服务端**恒定下发完整清单**
 * （模型可以只发改动条目，合并由服务端做），故这里整表替换、不做本地合并——面板永远等于服务端状态。
 *
 * 三态：pending / in_progress（当前正在做的那条——长任务靠它知道进行到哪了）/ done。
 * 折叠（2026-09-12，形态对齐主流）：**全部完成后默认收起**，点击标题展开回看；
 * 进行中恒展开——正跑着的时候把进度藏起来等于没有进度。
 */
import { useState } from 'react';
import type { TaskItem } from './useChatStream';
import './chat-extras.css';

export function TaskPanel({ items, streaming }: { items: TaskItem[]; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === 'done').length;
  const allDone = done === items.length;
  /** 只有「已完成」才给收起按钮；进行中的清单必须看得见 */
  const collapsible = allDone;
  const expanded = collapsible ? open : true;
  const title = allDone ? '任务清单' : streaming ? '正在执行' : '未完成的任务';

  return (
    <div className="chat-tasks">
      <button
        type="button"
        className="chat-tasks-head"
        onClick={() => collapsible && setOpen(!open)}
        aria-expanded={expanded}
        disabled={!collapsible}
        title={collapsible ? (open ? '收起清单' : '展开清单') : undefined}
      >
        <span className={`chat-tasks-dot${streaming && !allDone ? ' live' : ''}`} />
        <span className="chat-tasks-title">{title}</span>
        <span className="chat-tasks-progress">
          {done}/{items.length}
        </span>
        {collapsible && <span className="chat-tasks-caret">{open ? '收起' : '展开'}</span>}
      </button>
      {expanded && (
        <ul className="chat-tasks-list">
          {items.map((it, i) => (
            <li key={i} className={`chat-task ${it.status}`}>
              <span className="chat-task-mark" aria-hidden>
                {it.status === 'done' ? (
                  '✓'
                ) : it.status === 'in_progress' ? (
                  <span className="chat-task-spinner" />
                ) : (
                  ''
                )}
              </span>
              <span className="chat-task-text">{it.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
