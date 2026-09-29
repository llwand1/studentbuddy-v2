/**
 * DrillOverlay — 「等待时刷词」的整张弹窗（契约 `docs/WAIT-DRILL-SPEC.md` §5.1）：
 * 头部（品牌角标 + 战绩 + 音效 / 关闭）→ 「回复到了」横幅 → 卡片 + 特效层 → 状态行 → 键位脚注。
 *
 * ★ 与大陆弹窗同一套黑铁金线（`drill.css` 按 `grimoire.css` 的语言写，只用 `--gr-*` / `--sb-*` 变量）。
 * ★ 纯展示：状态机在 `useDrillSession`，弹与收在 `useDrillTrigger`，两者由 `WaitDrill` 拼起来。
 */
import type { DrillCard } from '@sb/shared';
import { DrillFx, type DrillFxState } from './DrillFx';
import { DrillQuestion } from './DrillQuestion';
import type { DrillEntry, DrillPhase, DrillResult, DrillStats } from './useDrillSession';
import './drill.css';
import './drill-fx.css';

export interface DrillOverlayProps {
  busy: boolean;
  replyReady: boolean;
  /** 回复到了之后还有几秒自动切回（不答也切） */
  readyCountdown: number;
  muted: boolean;
  phase: DrillPhase;
  card: DrillCard | null;
  entry: DrillEntry | null;
  result: DrillResult | null;
  fx: DrillFxState | null;
  stats: DrillStats;
  queueLeft: number;
  notice: string;
  newNote: string;
  onToggleSound: () => void;
  onClose: () => void;
  onLeaveNow: () => void;
  onStay: () => void;
  onAnswer: (a: number | string) => void;
  onDontKnow: () => void;
  onNext: () => void;
  onLearned: () => void;
  onSlay: () => void;
  onKeep: () => void;
  onDismiss: () => void;
}

export function DrillOverlay(p: DrillOverlayProps) {
  return (
    <div className="drill-overlay" role="dialog" aria-modal="true" aria-label="等待时刷词">
      <div className="drill-stage">
        <header className="drill-head">
          <div className="drill-brand">
            <span className="drill-brand-tag">WAIT</span>
            <b>等待时刷词</b>
            <small className={p.busy ? 'live' : ''}>{p.busy ? 'AI 正在回复…' : '回复到了'}</small>
          </div>
          <div className="drill-stats" aria-label="战绩">
            <span>
              连击 <b>{p.stats.combo}</b>
            </span>
            <span>
              答对 <b>{p.stats.correct}</b>
            </span>
            <span>
              斩 <b>{p.stats.slain}</b>
            </span>
            {p.stats.reviewed > 0 && (
              <span className="hot">
                打卡 <b>{p.stats.reviewed}</b>
              </span>
            )}
          </div>
          <div className="drill-tools">
            <button
              type="button"
              className={p.muted ? 'drill-icon muted' : 'drill-icon'}
              aria-pressed={!p.muted}
              title={p.muted ? '打开音乐与音效' : '关掉音乐与音效'}
              onClick={p.onToggleSound}
            >
              {p.muted ? '♪ 关' : '♪ 开'}
            </button>
            <button type="button" className="drill-icon" title="关闭（Esc）" onClick={p.onClose}>
              ✕
            </button>
          </div>
        </header>

        {p.replyReady && (
          <div className="drill-ready" role="status">
            <span>
              回复到了——答完这张自动切回（{p.readyCountdown}s）
            </span>
            <button type="button" className="drill-btn primary" onClick={p.onLeaveNow}>
              现在回去
            </button>
            <button type="button" className="drill-btn" onClick={p.onStay}>
              继续刷
            </button>
          </div>
        )}

        <div className="drill-body">
          <DrillQuestion
            phase={p.phase}
            card={p.card}
            entry={p.entry}
            result={p.result}
            notice={p.notice}
            onAnswer={p.onAnswer}
            onDontKnow={p.onDontKnow}
            onNext={p.onNext}
            onLearned={p.onLearned}
            onSlay={p.onSlay}
            onKeep={p.onKeep}
            onDismiss={p.onDismiss}
          />
          <DrillFx fx={p.fx} />
        </div>

        <p className="drill-notice" role="status" aria-live="polite">
          {p.notice || p.newNote}
        </p>
        <footer className="drill-foot">
          <span>1–4 选 · Enter 下一张 · N 不认识 · Z 斩 · Esc 关闭</span>
          <span>还有 {p.queueLeft} 张</span>
        </footer>
      </div>
    </div>
  );
}
