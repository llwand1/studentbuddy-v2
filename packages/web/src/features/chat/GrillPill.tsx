/**
 * GrillPill — grill-me 模式的「开着」提示条（v18，2026-09-16）。
 *
 * 为什么必须有它：模式开关收在「+」折叠菜单里，收进去就失去了可见性——
 * 用户会以为开关没生效。`composer-status.ts` 里「联网开着必说」是同一条规矩
 * （写错不报错、只是少一句提示，但用户会以为功能不存在）。
 */
import { useId, useState } from 'react';
import { GRILL_TOPIC_MAX, type GrillScope, type GrillTiming } from '@sb/shared';
import { useExamScope } from '../exam/useExamScope';
import './grill-scope.css';

export function GrillPill({ scope = { kind: 'conversation' }, onScopeChange, timing = 'adaptive', onTimingChange, disabled, onClose }: {
  scope?: GrillScope;
  onScopeChange?: (scope: GrillScope) => void;
  timing?: GrillTiming;
  onTimingChange?: (timing: GrillTiming) => void;
  disabled?: boolean;
  onClose: () => void;
}) {
  const exam = useExamScope();
  const [open, setOpen] = useState(scope.kind === 'custom' && !scope.topic);
  const panelId = useId();
  const summary = scope.kind === 'custom' ? scope.topic || '填写主题' : scope.kind === 'exam' ? `应试 · ${exam.summary || '待设置'}` : '当前对话';
  return (
    <div className="chat-grill-pill grill-scope-pill">
      <div className="grill-scope-row">
        <button type="button" className="grill-settings-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          <span className="grill-scope-rune" aria-hidden="true">◇</span><strong>GrillMe</strong>
          <span>{timing === 'adaptive' ? '按需追问' : '每轮先问'}</span>
          <span className="grill-scope-summary" title={summary}>{summary}</span><span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
        <button type="button" className="chat-grill-off" disabled={disabled} onClick={onClose}>关闭</button>
      </div>
      {open && <div id={panelId} className="grill-scope-settings">
        <label className="grill-scope-label">触发节奏
          <select aria-label="GrillMe 触发节奏" value={timing} disabled={disabled} onChange={e => onTimingChange?.(e.target.value as GrillTiming)}>
            <option value="adaptive">按需追问</option><option value="always">每轮先问</option>
          </select>
        </label>
        <label className="grill-scope-label">学习范围
          <select aria-label="GrillMe 学习范围" value={scope.kind} disabled={disabled} onChange={(e) =>
            onScopeChange?.({ kind: e.target.value as GrillScope['kind'], ...(e.target.value === 'custom' ? { topic: '' } : {}) })}>
            <option value="conversation">当前对话</option>
            <option value="exam">当前应试范围</option>
            <option value="custom">自定义主题</option>
          </select>
        </label>
        <p className="grill-scope-hint">{timing === 'adaptive' ? '明确的问题直接开始；需要选路线时先问一句。' : '每轮先选方向；点选收尾路线后直接继续。'}</p>
      {scope.kind === 'custom' ? <input className="grill-scope-topic" aria-label="自定义学习主题" value={scope.topic ?? ''}
        maxLength={GRILL_TOPIC_MAX} placeholder="例如：考研数学 · 线性代数 · 特征值" disabled={disabled}
        onChange={(e) => onScopeChange?.({ kind: 'custom', topic: e.target.value })} /> :
        <span className="grill-scope-hint">{scope.kind === 'exam'
          ? !exam.loaded ? '正在读取应试范围…' : exam.on && exam.hosts > 0 ? exam.summary : '请先开启应试模式并设置白名单，也可以让 AI 帮你设置'
          : '围绕当前对话与本次提问，回答后提供具体的下一步'}</span>}
      </div>}
    </div>
  );
}
