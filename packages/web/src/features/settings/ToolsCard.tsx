/**
 * ToolsCard — 设置页「工具」卡（契约 docs/TOOL-ECOSYSTEM-SPEC.md §6.3-4 阈值、§4.5 统计，P3 步骤 7）。
 *
 * 两件事：① 确认门阈值三档（1=每次都问 / 5=默认 / 0=从不等，拍板⑮）——**0 档必须写明风险**
 *   （§9 风险表「确认疲劳→用户关掉确认门」是本卡首害，文案如实念「AI 可自由改库」）；
 * ② 每工具 30 天调用统计 + 删除快照总条数——「本会话 AI 累计改动 N 条」的审计可见性来源。
 *
 * 样式复用 settings.css 既有基元（quiz-mix-chip / settings-table），不新造视觉语言；
 * 点选即存（同 QuizImageCard：两取值之间的独立保存按钮只会制造「改了没存」）。
 */
import { useCallback, useEffect, useState } from 'react';
import { CONFIRM_THRESHOLD_CHOICES } from '@sb/shared';
import { api } from '../../lib/api';
import type { ToolStatSummary } from '../../lib/api-tools';
import { toolLabel } from '../chat/chat-meta';
import './settings.css';

/** 三档的人话标题（值本身是「影响几条才弹」的整数，档位语义必须写在脸上） */
const THRESHOLD_LABELS: Record<number, string> = {
  1: '每次都问',
  5: '默认：改动多才问',
  0: '从不等',
};

export function ToolsCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [threshold, setThreshold] = useState<number | null>(null);
  const [stats, setStats] = useState<ToolStatSummary[]>([]);
  const [deleteLogTotal, setDeleteLogTotal] = useState(0);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void api.tools
      .confirmThreshold()
      .then((r) => setThreshold(r.threshold))
      .catch((e: unknown) => flash(false, e instanceof Error ? e.message : String(e)));
    void api.tools
      .stats()
      .then((r) => {
        setStats(r.stats);
        setDeleteLogTotal(r.deleteLogTotal);
      })
      .catch(() => setStats([])); // 统计是附属可见性：拉不到不该挡住阈值设置整卡，空表如实呈现
  }, [flash]);

  useEffect(reload, [reload]);

  const pick = async (next: number) => {
    if (busy || next === threshold) return;
    setBusy(true);
    try {
      const r = await api.tools.saveConfirmThreshold(next);
      setThreshold(r.threshold); // 显示落库值而不是点击值（归一化可能改判）
      flash(true, `已保存：改动超过 ${r.threshold} 条才弹确认`);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-sec">
      <h3>工具</h3>
      <p className="settings-hint">
        AI 改词条库前的确认门槛：影响条数 ≤ 阈值直接执行，超过则弹确认卡。
        删除词条<b>永远要确认，不受本设置影响</b>（不可逆的没得商量）。
      </p>

      <div className="quiz-mix-presets">
        {CONFIRM_THRESHOLD_CHOICES.map((v) => (
          <button
            key={v}
            className={threshold === v ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
            disabled={busy || threshold === null}
            onClick={() => void pick(v)}
          >
            {THRESHOLD_LABELS[v] ?? `阈值 ${v}`}
          </button>
        ))}
      </div>

      {threshold === 0 ? (
        <p className="settings-hint warn">
          你已关闭确认门：超过阈值的批量改动 AI 会<b>不询问直接落库</b>。
          出问题可在词条页撤销删除批次，但改错释义没有撤销。
        </p>
      ) : null}

      <div className="settings-actions">
        <span className="settings-state">
          {threshold === null ? '读取中…' : `当前：改动超过 ${threshold} 条才问`}
        </span>
        <button className="settings-add" onClick={reload}>
          刷新统计
        </button>
      </div>

      <table className="settings-table">
        <thead>
          <tr>
            <th>工具</th>
            <th>调用</th>
            <th>失败</th>
            <th>p95 耗时</th>
            <th>改动条数</th>
            <th>批准 / 拒绝</th>
          </tr>
        </thead>
        <tbody>
          {stats.length === 0 ? (
            <tr>
              <td colSpan={6}>近 30 天没有工具调用记录</td>
            </tr>
          ) : (
            stats.map((s) => (
              <tr key={s.tool}>
                <td>
                  {toolLabel(s.tool)}
                  {s.source === 'mcp' ? <span className="settings-tag">MCP</span> : null}
                </td>
                <td>{s.calls}</td>
                <td>{s.failures > 0 ? <span className="num-bad">{s.failures}</span> : s.failures}</td>
                <td>{(s.p95Ms / 1000).toFixed(1)}s</td>
                <td>{s.affectedTotal}</td>
                <td>
                  {s.confirmAllowed} / {s.confirmDenied}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p className="settings-hint">
        词条删除快照共 <b>{deleteLogTotal}</b> 条未过期批次可在「词条」页顶部撤销；统计窗口为近 30 天。
      </p>
    </section>
  );
}
