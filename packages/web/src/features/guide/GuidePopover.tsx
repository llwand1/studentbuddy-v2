/**
 * GuidePopover — 引路灯弹层（契约 `docs/GUIDE-SPEC.md` §8）：图标正下方竖排的 2–4 个选项 + 「全部功能」目录 + 页脚。
 *
 * 只负责渲染与上报点击；「推荐从哪来 / 点了怎么执行 / 键盘」都在 `GuideBeacon` 与 `use-guide`。
 * ★ 选项前的序号（1–4）与页脚的 Esc 是**快捷键写在能用的地方**（FEATURES「顺手的小设计」的纪律）。
 * ★ 「全部功能」按「对话 / 练习 / 去哪儿」分组，当前做不了的灰着并写一句「怎么解锁」——迷路时当使用说明，
 *   不靠 AI，没模型也能用。
 */
import { forwardRef, useState } from 'react';
import {
  GUIDE_CATALOG,
  GUIDE_GROUPS,
  GUIDE_KINDS,
  type GuideGroup,
  type GuideItem,
  type GuideKind,
  type GuideLang,
  type GuideReason,
  type GuideResult,
} from '@sb/shared';
import { GUIDE_COPY as T, GUIDE_REASON_COPY } from './guide-copy';
import type { GuideSource } from './use-guide';

const GROUP_ORDER: readonly GuideGroup[] = ['chat', 'quiz', 'go'];

interface Props {
  id: string;
  lang: GuideLang;
  source: GuideSource;
  result: GuideResult;
  reason?: GuideReason | 'failed';
  /** 此刻可执行的动作（目录里不在其中的灰着） */
  can: readonly GuideKind[];
  held: boolean;
  notice: string;
  proactive: boolean;
  onPick: (item: GuideItem) => void;
  onPickKind: (kind: GuideKind) => void;
  onRefresh: () => void;
  onApplyHeld: () => void;
  onTouch: () => void;
  onClose: () => void;
  onProactive: (on: boolean) => void;
}

const BADGE: Record<GuideSource, keyof typeof T> = { ai: 'badgeAi', rules: 'badgeRules', loading: 'badgeLoading' };

export const GuidePopover = forwardRef<HTMLDivElement, Props>(function GuidePopover(p, ref) {
  const { lang, result } = p;
  const [allOpen, setAllOpen] = useState(false);
  const can = new Set<GuideKind>(p.can);
  return (
    <div className="guide-pop" id={p.id} ref={ref} role="region" aria-label={T.title[lang]} tabIndex={-1}>
      <div className="guide-pop-head">
        <span className="guide-pop-title">{T.title[lang]}</span>
        <span className={`guide-badge is-${p.source}`}>{T[BADGE[p.source]][lang]}</span>
        <button type="button" className="guide-icon-btn" onClick={p.onRefresh} disabled={p.source === 'loading'} aria-label={T.refresh[lang]} title={T.refresh[lang]}>
          ↻
        </button>
        <button type="button" className="guide-icon-btn guide-pop-x" onClick={p.onClose} aria-label={T.close[lang]} title={T.close[lang]}>
          ✕
        </button>
      </div>
      <p className="guide-headline">{result.headline}</p>
      {p.held && (
        <button type="button" className="guide-fresh" onClick={p.onApplyHeld}>
          {T.fresher[lang]}
        </button>
      )}
      {p.reason && (
        <p className="guide-reason" role="note">
          {GUIDE_REASON_COPY[p.reason][lang]}
        </p>
      )}
      {result.items.length === 0 ? (
        <p className="guide-empty">{T.nothingYet[lang]}</p>
      ) : (
        <ol className="guide-list">
          {result.items.map((it, i) => (
            <li key={`${it.kind}-${it.text ?? i}`}>
              <button
                type="button"
                className="guide-item"
                data-kind={it.kind}
                aria-keyshortcuts={String(i + 1)}
                title={it.text ? `${T.willSend[lang]}「${it.text}」` : undefined}
                onPointerEnter={p.onTouch}
                onFocus={p.onTouch}
                onClick={() => p.onPick(it)}
              >
                <span className="guide-key" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="guide-item-body">
                  <span className="guide-item-label">{it.label}</span>
                  <span className="guide-item-hint">{it.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {p.notice && (
        <p className="guide-notice" role="alert">
          {p.notice}
        </p>
      )}
      <button type="button" className="guide-all-toggle" aria-expanded={allOpen} aria-controls={`${p.id}-all`} onClick={() => setAllOpen((v) => !v)}>
        <span aria-hidden="true">{allOpen ? '▾' : '▸'}</span> {T.allFeatures[lang]}（{GUIDE_KINDS.length}）
      </button>
      {allOpen && (
        <div className="guide-all" id={`${p.id}-all`}>
          {GROUP_ORDER.map((g) => (
            <section key={g} className="guide-group" aria-label={GUIDE_GROUPS[g][lang]}>
              <h3 className="guide-group-title">{GUIDE_GROUPS[g][lang]}</h3>
              {GUIDE_KINDS.filter((k) => GUIDE_CATALOG[k].group === g).map((k) => {
                const info = GUIDE_CATALOG[k];
                const on = can.has(k);
                return (
                  <button key={k} type="button" className="guide-row" data-kind={k} disabled={!on} onClick={() => p.onPickKind(k)}>
                    <span className="guide-row-label">{info.label[lang]}</span>
                    <span className="guide-row-hint">{on ? info.hint[lang] : info.need[lang]}</span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}
      <div className="guide-foot">
        <label className="guide-proactive" title={T.proactiveTitle[lang]}>
          <input type="checkbox" checked={p.proactive} onChange={(e) => p.onProactive(e.target.checked)} /> {T.proactive[lang]}
        </label>
        <span className="guide-esc">{T.escHint[lang]}</span>
      </div>
    </div>
  );
});
