/**
 * DrillOverlay — 「等待时刷词」的整张小窗（契约 `docs/WAIT-DRILL-SPEC.md` §5.1 / §5.6）：
 * 头部（品牌角标 + 战绩 + 音效 / 关闭，**也是拖柄**）→ 「回复到了」横幅 → 卡片 + 特效层 → 状态行 → 键位脚注。
 *
 * ★ 2026-09-30 起是**非模态可拖动浮窗**（不压暗背景、不挡对话与右侧资料架）：右侧常驻「资料架」之后，
 *   居中模态会把 AI 在看的资料挡个正着——学习者自己把它拖到左边或中间（`useDragWindow`，位置记在本机偏好）。
 * ★ 与大陆弹窗同一套黑铁金线（`drill.css` 按 `grimoire.css` 的语言写，只用 `--gr-*` / `--sb-*` 变量）。
 * ★ ✕ / Esc 是**收起**不是作废（§2.1，2026-09-30）：这一局留在宿主里，输入框上方的小签能唤回；小签上的 ✕ 才结束。
 * ★ 纯展示：状态机在 `useDrillSession`，弹与收在 `useDrillTrigger`，两者由 `WaitDrill` 拼起来。
 */
import { useEffect, useRef } from 'react';
import type { DrillCard } from '@sb/shared';
import { DrillFx, type DrillFxState } from './DrillFx';
import { DrillQuestion } from './DrillQuestion';
import type { DrillEntry, DrillPhase, DrillResult, DrillStats } from './useDrillSession';
import { useDragWindow, type WindowPos } from './useDragWindow';
import './drill.css';
import './drill-fx.css';

export interface DrillOverlayProps {
  busy: boolean;
  replyReady: boolean;
  /** 练习局（从入口手动打开、没在等回复）：头部不说「回复到了」 */
  practice: boolean;
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
  draft: string;
  onDraft: (v: string) => void;
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
  /** 浮窗上次的位置（无＝居中）与拖完的回写（§5.6） */
  windowPos: WindowPos | null;
  onWindowMoved: (pos: WindowPos) => void;
}

/** 底部快捷键提示按这张卡的操作方式换词：拼写卡没有 1–4，学新词那屏只有 Enter。 */
function footHint(phase: DrillPhase, card: DrillCard | null): string {
  if (phase === 'learn') return 'Enter 记住了来一题 · Esc 收起';
  if (card?.kind === 'spell') return '逐字打词条 Enter 提交 · N 不认识 · Z 斩 · Esc 收起';
  return '1–4 选 · Enter 下一张 · N 不认识 · Z 斩 · Esc 收起';
}

export function DrillOverlay(p: DrillOverlayProps) {
  /**
   * 打开时把焦点挪进小窗、关掉时还回去（多半是聊天输入框——回复到了正好接着打字）。
   * ★ 不挪焦点的后果在真机上见过：发送完消息焦点还在聊天框里，按 1–4 什么都不发生。
   *   小窗是非模态的：之后学习者点回聊天框打字，按键就归聊天框（`useDrillKeys` 只在焦点不在外部输入框时接键）。
   */
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stage.current?.focus({ preventScroll: true });
    return () => {
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);
  useDragWindow(stage, { handle: '.drill-head', initial: p.windowPos, onSettle: p.onWindowMoved });
  return (
    <div className="drill-overlay" role="dialog" aria-label="等待时刷词">
      <div className="drill-stage" ref={stage} tabIndex={-1}>
        <header className="drill-head" title="按住这里拖动小窗">
          <div className="drill-brand">
            <span className="drill-brand-tag">WAIT</span>
            <b>等待时刷词</b>
            <small className={p.busy ? 'live' : ''}>{p.busy ? 'AI 正在回复…' : p.practice ? '练习局' : '回复到了'}</small>
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
            <button type="button" className="drill-icon" title="收起（Esc）——输入框上方的小签可唤回，这局不作废" onClick={p.onClose}>
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
            draft={p.draft}
            onDraft={p.onDraft}
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
          <span>{footHint(p.phase, p.card)}</span>
          <span>还有 {p.queueLeft} 张</span>
        </footer>
      </div>
    </div>
  );
}
