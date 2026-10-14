import type { DesktopRun } from '@sb/shared';
export const RUN_STATUS: Record<DesktopRun['status'], string> = { queued: '排队', running: '执行中', waiting_permission: '等待许可', completed: '完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
export function WorkbenchRunCard({ run, childrenCount, onSelect, onCancel, onRetry, onSession }: {
  run: DesktopRun; childrenCount: number; onSelect: () => void; onCancel: () => void; onRetry: () => void; onSession: () => void;
}) {
  const active = ['queued','running','waiting_permission'].includes(run.status);
  const done = run.tasks.filter(t => t.status === 'done').length;
  return <article className={`wb-run ${run.parentId ? 'is-child' : ''}`}>
    <button className="wb-run-open" onClick={onSelect}><span className={`wb-status ${run.status}`}>{RUN_STATUS[run.status]}</span><strong>{run.title}</strong></button>
    <p>{run.kind === 'chat' ? '主对话' : run.kind === 'quiz' ? '逐题 Agent' : run.parentId ? '子 Agent' : '独立 Agent'}
      {run.stage && ` · ${run.stage}`}{childrenCount > 0 && ` · ${childrenCount} 个子任务`}</p>
    {run.tasks.length > 0 && <><progress value={done} max={run.tasks.length} aria-label="任务完成进度" /><span className="wb-count">{done}/{run.tasks.length}</span>
      <ul className="wb-checklist">{run.tasks.map((t, i) => <li key={i} data-status={t.status}>{t.status === 'done' ? '✓' : t.status === 'in_progress' ? '◉' : '○'} {t.text}</li>)}</ul></>}
    {run.error && <p className="desktop-error">{run.error}</p>}
    <div className="wb-actions">{active && <button onClick={onCancel}>停止{childrenCount ? '及子任务' : ''}</button>}
      {!active && run.kind === 'agent' && ['failed','cancelled','interrupted'].includes(run.status) && <button onClick={onRetry}>重试</button>}
      {run.sessionId && <button onClick={onSession}>回到对话</button>}<small>{new Date(run.updatedAt).toLocaleTimeString()} 更新</small></div>
  </article>;
}
