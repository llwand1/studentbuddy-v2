import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopCapability, DesktopRunEvent } from '@sb/shared';
import { DESKTOP_ACTIVE_STATUSES } from '@sb/shared';
import { isLocalDesktopAddress } from './desktop-api';
import { workbenchApi, type WorkbenchState } from './workbench-api';
import { WorkbenchFiles } from './WorkbenchFiles';
import { WorkbenchRunCard, RUN_STATUS } from './WorkbenchRunCard';
import './workbench.css';
import { watchDesktopInput } from './desktop-input';

/** Global, independent of ChatView and its scroll/message lifetime. Polling never starts AI work. */
export function DesktopWorkbench({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [data, setData] = useState<WorkbenchState | null>(null), [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'tasks' | 'agents' | 'files' | 'mechanism'>('tasks');
  const [error, setError] = useState(''), [prompt, setPrompt] = useState(''), [creating, setCreating] = useState(false);
  const [capability, setCapability] = useState<DesktopCapability>('read_only');
  const [filter, setFilter] = useState<'all'|'active'|'completed'|'failed'>('all');
  const [selected, setSelected] = useState(''), [events, setEvents] = useState<DesktopRunEvent[]>([]);
  const toggle = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLElement>(null);
  useEffect(() => watchDesktopInput(value => { if (value.focus || value.capture || value.error) setOpen(false); }), []);
  const refresh = useCallback(async () => {
    if (!isLocalDesktopAddress()) return;
    try { setData(await workbenchApi.state()); }
    catch (e) { if (open) setError(e instanceof Error ? e.message : '任务状态暂时不可用'); }
  }, [open]);
  useEffect(() => {
    let alive = true;
    const load = async () => { if (alive) await refresh(); };
    void load(); const timer = setInterval(() => { void load(); }, open ? 1500 : 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [refresh, open]);
  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener('keydown', escape); return () => document.removeEventListener('keydown', escape);
  }, [open]);
  useEffect(() => {
    if (!selected || !open) return;
    let alive = true;
    void workbenchApi.detail(selected).then(d => { if (alive) setEvents(d.events); }).catch(() => {});
    return () => { alive = false; };
  }, [selected, open, data]);
  const action = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } };
  if (!data) return null;
  const active = data.runs.filter(r => DESKTOP_ACTIVE_STATUSES.includes(r.status)).length;
  const focused = data.runs.find(r => r.id === selected);
  const visibleRun = (r: WorkbenchState['runs'][number]) => filter === 'all' || (filter === 'active' ? DESKTOP_ACTIVE_STATUSES.includes(r.status) : filter === 'failed' ? ['failed','interrupted','cancelled'].includes(r.status) : r.status === 'completed');
  const roots = data.runs.filter(r => !r.parentId && (tab !== 'agents' || r.kind !== 'chat') && visibleRun(r))
    .sort((a,b) => Number(DESKTOP_ACTIVE_STATUSES.includes(b.status))-Number(DESKTOP_ACTIVE_STATUSES.includes(a.status)) || b.updatedAt-a.updatedAt);
  const childRuns = data.runs.filter(r => r.parentId);
  const card = (run: WorkbenchState['runs'][number]) => <WorkbenchRunCard key={run.id} run={run}
    childrenCount={childRuns.filter(r => r.parentId === run.id).length} onSelect={() => setSelected(run.id)}
    onCancel={() => void action(() => workbenchApi.cancel(run.id))} onRetry={() => void action(() => workbenchApi.retry(run.id))}
    onSession={() => { if (run.sessionId) onOpenSession(run.sessionId); setOpen(false); }} />;
  return <>
    <button ref={toggle} type="button" className={`reading-tool wb-entry${data.approvals.length ? ' needs-permission' : ''}`} aria-label={`任务中心${data.approvals.length ? ` · ${data.approvals.length} 项待许可` : active ? ` · ${active} 项执行中` : ''}`}
      aria-expanded={open} onClick={() => setOpen(v => !v)} title="任务、子 Agent 与本机工作区"><span aria-hidden="true">☷</span>{(active > 0 || data.approvals.length > 0) && <b>{data.approvals.length || active}</b>}</button>
    {open && <><button className="wb-backdrop" aria-label="关闭任务中心" onClick={() => setOpen(false)} />
      <section className="wb-panel" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="任务与工作区">
        <header className="wb-head"><div><h2>任务与工作区</h2><p>{active} 项活跃 · 子 Agent 并发上限 3</p></div><button aria-label="收起任务中心" onClick={() => { setOpen(false); toggle.current?.focus(); }}>×</button></header>
        <nav className="wb-tabs" aria-label="任务中心页面">{(['tasks','agents','files','mechanism'] as const).map(k => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{({tasks:'任务',agents:'Agent',files:'文件',mechanism:'机制'})[k]}</button>)}</nav>
        <div className="wb-body">
          {error && <p role="alert" className="desktop-error">{error}</p>}
          {data.approvals.map(a => <article className="wb-approval" key={a.id}><strong>需要你的文件许可</strong><p>{a.operation === 'read' ? '读取' : a.operation === 'list' ? '列出目录' : '写入'}：{a.path}</p><p>{a.reason}</p><small>仅此次操作有效，不授予整盘或后续访问。</small>
            <p className="wb-policy">{a.runId ? '允许读取后，必要内容可能发送给你配置的 AI 模型提供商，用于当前任务。' : '此操作用于本地文件预览，不自动提交给 AI。'}</p>
            <div className="wb-actions"><button onClick={() => void action(() => workbenchApi.approve(a.id, true))}>允许一次</button><button onClick={() => void action(() => workbenchApi.approve(a.id, false))}>拒绝</button></div></article>)}
          {(tab === 'tasks' || tab === 'agents') && <>
            <form className="wb-new-task" onSubmit={e => { e.preventDefault(); setCreating(true); void action(async () => { await workbenchApi.create(prompt, capability); setPrompt(''); }).finally(() => setCreating(false)); }}>
              <label>独立任务<textarea aria-label="独立任务描述" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="例如：读取工作区的讲义，生成复习提纲保存为 summary.md" /></label>
              <div className="wb-actions"><select aria-label="Agent 文件权限" value={capability} onChange={e => setCapability(e.target.value as DesktopCapability)}><option value="read_only">只读 Agent</option><option value="workspace_write">工作区可写 Agent</option></select><button disabled={!prompt.trim() || creating}>开始任务</button></div>
            </form>
            <label>显示任务<select aria-label="任务状态筛选" value={filter} onChange={e => setFilter(e.target.value as typeof filter)}><option value="all">全部</option><option value="active">执行中 / 排队 / 待许可</option><option value="completed">已完成</option><option value="failed">失败 / 中断 / 取消</option></select></label>
            {!roots.length && <p className="wb-empty">暂无任务。可以创建独立任务，也会自动记录主对话任务、委派与逐题分析。</p>}
            {roots.map(r => <div key={r.id}>{card(r)}{childRuns.filter(c => c.parentId === r.id).map(card)}</div>)}
            {childRuns.filter(r => !roots.some(p => p.id === r.parentId) && visibleRun(r)).map(card)}
            <h3>后台任务</h3>{data.jobs.length ? data.jobs.map(j => <p className="wb-job" key={j.id}>{j.label} · {({queued:'排队',running:'执行中',done:'完成',failed:'失败'})[j.status as 'queued']} · 尝试 {j.attempts} 次{j.error && ` · ${j.error}`}{j.status === 'failed' && <button onClick={() => void action(() => workbenchApi.retryJob(j.id))}>重试后台任务</button>}</p>) : <p className="wb-empty">当前没有后台队列任务。</p>}
          </>}
          {tab === 'files' && <WorkbenchFiles workspace={data.workspace} onChanged={() => void refresh()} />}
          {tab === 'mechanism' && <section className="wb-mechanism"><h3>主 Agent 与子 Agent</h3><p>主对话维护上下文与工具循环；同一会话串行。delegate_task 委派自包含任务，子 Agent 有独立上下文、模型调用、进度和结果，完成后仅返回摘要。</p><p>子 Agent 每个用户最多并行 3 个，排队最多 20 个，最多 8 轮、8 分钟；不再派生子 Agent。只读能力不能升级，工作区可写也不能写到工作区外。</p><h3>逐题 Agent 与后台队列</h3><p>原有逐题池也是并发 3 个，分阶段核对、分析和图示，支持逐题重试。后台队列处理备题、记忆等业务，不是通用子 Agent。</p><h3>权限与持久化</h3><p>敏感路径和正文凭据特征触发具体文件的单次许可。重启会把未结束任务标为中断，不自动重放写入；可查看记录后手动重试。任务清单独立于消息滚动保存，停止父任务会停止其子任务。</p></section>}
          {focused && <section className="wb-detail"><header><h3>任务详情</h3><button onClick={() => setSelected('')}>收起详情</button></header><p>{focused.title} · {RUN_STATUS[focused.status]}</p><p>权限：{focused.capability === 'read_only' ? '只读' : '工作区可写'}{focused.model && ` · 模型：${focused.model}`}</p><p>父任务：{focused.parentId || '无（根任务）'}</p>{focused.result && <pre className="wb-result">{focused.result}</pre>}<ol>{events.map(e => <li key={e.id}>{new Date(e.createdAt).toLocaleTimeString()} · {e.summary}</li>)}</ol></section>}
        </div>
      </section></>}
  </>;
}
