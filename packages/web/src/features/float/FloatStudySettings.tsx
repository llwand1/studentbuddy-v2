import { useState } from 'react';
import type { DesktopStudySettings, DesktopStudyState } from '@sb/shared';
import { BrowserControls } from '../desktop/BrowserControls';
import { QuizRoundHistoryPanel } from '../quiz/QuizRoundHistory';
import { QuizCard } from '../quiz/QuizCard';
export function FloatStudySettings({ state, onSave }: { state: DesktopStudyState | null; onSave: (s: DesktopStudySettings) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(false);
  const save = (settings: DesktopStudySettings) => {
    setBusy(true); setError('');
    void onSave(settings).catch(e => setError(e instanceof Error ? e.message : '保存失败，请重试')).finally(() => setBusy(false));
  };
  return <div className="desktop-settings-scroll"><section className="desktop-timer-settings" aria-label="定时出题设置">
    <h2>篝火小练习</h2><p>到点只出现一张题卡。做完、跳过后重新计时；展开应用或隐藏悬浮球时，先让你专注当前任务。</p>
    {state ? <><label className="desktop-toggle"><input type="checkbox" checked={state.settings.enabled} disabled={busy}
      onChange={e => save({ ...state.settings, enabled: e.target.checked })} /> 开启自动出题</label>
      <label>出题间隔<select value={state.settings.intervalMinutes} disabled={busy} onChange={e => save({ ...state.settings, intervalMinutes: Number(e.target.value) })}>
        {[1, 3, 5, 10, 15, 30, 60].map(n => <option key={n} value={n}>每 {n} 分钟</option>)}
        {![1, 3, 5, 10, 15, 30, 60].includes(state.settings.intervalMinutes) && <option value={state.settings.intervalMinutes}>每 {state.settings.intervalMinutes} 分钟</option>}
      </select></label><label>练习范围<select value={state.settings.scope} disabled={busy} onChange={e => save({ ...state.settings, scope: e.target.value === 'browser' ? 'browser' : 'learning' })}>
        <option value="learning">当前学习方向／应试范围</option><option value="browser">正在共读的网页</option></select></label>
      <p className="desktop-timer-status" aria-live="polite">{state.awaiting ? '还有一道待做题，返回后可继续' : !state.settings.enabled ? '自动出题已关闭' : state.error || (state.nextAt ? `下次约 ${new Date(state.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '正在备题')}{state.preparing ? ' · 正在提前备题' : ''}</p></> : <p>正在连接本机服务…</p>}
    {error && <p role="alert" className="desktop-error">{error}</p>}
    <button type="button" className="quiz-gen-btn" onClick={() => setHistory(true)}>最近作答记录</button>
  </section><BrowserControls />{history && <QuizRoundHistoryPanel onClose={() => setHistory(false)} renderRound={id => <QuizCard key={id} recordId={id} title="历史作答" questions={[]} compact />} />}</div>;
}
