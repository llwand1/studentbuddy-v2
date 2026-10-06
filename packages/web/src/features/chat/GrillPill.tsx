/**
 * GrillPill — grill-me 模式的「开着」提示条（v18，2026-09-16）。
 *
 * 为什么必须有它：模式开关收在「+」折叠菜单里，收进去就失去了可见性——
 * 用户会以为开关没生效。`composer-status.ts` 里「联网开着必说」是同一条规矩
 * （写错不报错、只是少一句提示，但用户会以为功能不存在）。
 */
import { GRILL_TOPIC_MAX, type GrillScope } from '@sb/shared';
import { useExamScope } from '../exam/useExamScope';
import './grill-scope.css';

export function GrillPill({ scope = { kind: 'conversation' }, onScopeChange, disabled, onClose }: {
  scope?: GrillScope;
  onScopeChange?: (scope: GrillScope) => void;
  disabled?: boolean;
  onClose: () => void;
}) {
  const exam = useExamScope();
  return (
    <div className="chat-grill-pill grill-scope-pill">
      <div className="grill-scope-row">
        <span className="grill-scope-title">✦ GrillMe 追问</span>
        <label className="grill-scope-label">学习范围
          <select aria-label="GrillMe 学习范围" value={scope.kind} disabled={disabled} onChange={(e) =>
            onScopeChange?.({ kind: e.target.value as GrillScope['kind'], ...(e.target.value === 'custom' ? { topic: '' } : {}) })}>
            <option value="conversation">当前对话</option>
            <option value="exam">当前应试范围</option>
            <option value="custom">自定义主题</option>
          </select>
        </label>
        <button type="button" className="chat-grill-off" disabled={disabled} onClick={onClose}>关闭</button>
      </div>
      {scope.kind === 'custom' ? <input className="grill-scope-topic" aria-label="自定义学习主题" value={scope.topic ?? ''}
        maxLength={GRILL_TOPIC_MAX} placeholder="例如：考研数学 · 线性代数 · 特征值" disabled={disabled}
        onChange={(e) => onScopeChange?.({ kind: 'custom', topic: e.target.value })} /> :
        <span className="grill-scope-hint">{scope.kind === 'exam'
          ? !exam.loaded ? '正在读取应试范围…' : exam.on && exam.hosts > 0 ? exam.summary : '请先开启应试模式并设置白名单，也可以让 AI 帮你设置'
          : '围绕这段对话与本次提问，选方向、学知识、再追问'}</span>}
    </div>
  );
}
