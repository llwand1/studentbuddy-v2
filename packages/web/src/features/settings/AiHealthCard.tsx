/**
 * AiHealthCard — 设置页「AI 运行状况」：近 7 天每种 AI 用途的成功率/耗时/失败原因 + 后台任务（可重试）。
 * ★ 让"AI 为什么没出结果"有处可查：以前出题/抽词失败只在服务端日志里，用户只看到"没反应"。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiCallStats } from '@sb/shared';
import { aiOpsApi } from '../../lib/api-ai-ops';
import type { JobsResponse } from '../../lib/api-ai-ops';

const REASON: Record<string, string> = {
  'no-model': '没配模型', timeout: '超时', aborted: '已取消', upstream: '服务商报错', parse: '输出不成形',
};
const JOB_STATUS: Record<string, string> = { queued: '排队中', running: '执行中', done: '已完成', failed: '失败' };

export function reasonLabel(r: string): string {
  return REASON[r] ?? r;
}

function rate(ok: number, calls: number): string {
  return calls === 0 ? '—' : `${Math.round((ok / calls) * 100)}%`;
}

function secs(ms: number): string {
  return ms === 0 ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function AiHealthCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [stats, setStats] = useState<AiCallStats | null>(null);
  const [jobs, setJobs] = useState<JobsResponse | null>(null);

  // ★ 父组件的 flash 每次渲染都是新函数；放进依赖会"渲染→拉取→渲染"死循环，故走 ref。
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const reload = useCallback(() => {
    aiOpsApi.stats(7).then(setStats).catch((e: unknown) => flashRef.current(false, e instanceof Error ? e.message : String(e)));
    aiOpsApi.jobs().then(setJobs).catch(() => setJobs(null));
  }, []);

  useEffect(() => reload(), [reload]);

  const retry = async (id: string) => {
    try {
      await aiOpsApi.retryJob(id);
      flash(true, '已重新排队');
      reload();
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    }
  };

  const failed = jobs?.jobs.filter((j) => j.status === 'failed') ?? [];

  return (
    <section className="settings-sec" aria-label="AI 运行状况">
      <h3>AI 运行状况</h3>
      <p className="settings-hint">
        近 7 天每种 AI 用途的成功率、耗时和失败原因。输出不成形时会自动修复一次，后台任务失败会退避重试。
      </p>
      <div className="settings-actions">
        <span className="settings-state">
          {stats ? `共 ${stats.calls} 次调用，成功 ${rate(stats.ok, stats.calls)}` : '读取中…'}
          {jobs ? ` · 后台任务：排队 ${jobs.counts.queued}，失败 ${jobs.counts.failed}` : ''}
        </span>
        <button className="settings-add" onClick={reload}>刷新</button>
      </div>

      <table className="settings-table">
        <thead>
          <tr><th>用途</th><th>调用</th><th>成功率</th><th>p50 / p95</th><th>失败原因</th></tr>
        </thead>
        <tbody>
          {!stats || stats.purposes.length === 0 ? (
            <tr><td colSpan={5}>近 7 天没有 AI 调用记录</td></tr>
          ) : stats.purposes.map((p) => (
            <tr key={p.purpose}>
              <td>{p.label}<span className="settings-tag">v{p.version}</span></td>
              <td>{p.calls}</td>
              <td>{rate(p.ok, p.calls)}</td>
              <td>{secs(p.p50Ms)} / {secs(p.p95Ms)}</td>
              <td>{Object.entries(p.failures).map(([k, n]) => `${reasonLabel(k)} ${n}`).join('，') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {stats && stats.recentFailures.length > 0 && (
        <details className="settings-hint">
          <summary>最近的失败（{stats.recentFailures.length}）</summary>
          <ul>
            {stats.recentFailures.map((f, i) => (
              <li key={i}>{f.label} · {reasonLabel(f.status)}{f.error ? `：${f.error}` : ''}</li>
            ))}
          </ul>
        </details>
      )}

      {failed.length > 0 && (
        <table className="settings-table" aria-label="失败的后台任务">
          <thead><tr><th>后台任务</th><th>状态</th><th>尝试</th><th>错误</th><th /></tr></thead>
          <tbody>
            {failed.map((j) => (
              <tr key={j.id}>
                <td>{j.label}</td>
                <td>{JOB_STATUS[j.status] ?? j.status}</td>
                <td>{j.attempts}/{j.maxAttempts}</td>
                <td>{j.lastError ?? '—'}</td>
                <td><button className="settings-add" onClick={() => void retry(j.id)}>重试</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
