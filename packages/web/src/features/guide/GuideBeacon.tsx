/**
 * GuideBeacon — 引路灯：主区左上角的提灯 + 点开后图标正下方竖排的下一步选项（契约 `docs/GUIDE-SPEC.md`）。
 *
 * 本组件做四件事：① 把壳层自己能做的动作（开新对话、随机话题、跳页）**登记**进能力注册表；
 * ② 把点选落成「找最近登记的处理器执行」——没有就如实说「现在做不了」；③ 键盘（Esc / ↑↓ / 1–4）与点外面收起；
 * ④ 悬停 0.4 秒 / 聚焦时预取 AI 推荐。状态机在 `use-guide`，弹层渲染在 `GuidePopover`。
 *
 * ★ 「功能会来找你」的落点：关键时刻灯自己亮（晃动 + 光晕 + 小点，宽屏再冒一句短提示）；点开就是 AI 现挑的下一步。
 *   它不是又一个要用户先想起来的入口——灯会在该亮的时候亮。
 * ★ `chat.topic` 不直接发话：把话放进信箱、请 App 切到未选会话态，ChatView 取信走既有的 `useQuickStart.fire`
 *   （开会话 → 等 SSE 就绪 → 自动发出），不另造一条发送路径。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { GUIDE_CATALOG, GUIDE_TEXT_KINDS, defaultGuideText, type GuideItem, type GuideKind, type GuideLang } from '@sb/shared';
import { PK_HASH, type View } from '../../app/nav';
import { Lantern } from './Lantern';
import { GuidePopover } from './GuidePopover';
import { GUIDE_COPY as T } from './guide-copy';
import { getGuideChat, putGuideMail, runGuideCap } from './guide-store';
import { useGuideCaps } from './use-guide-cap';
import { GUIDE_HOVER_PREFETCH_MS, useGuide } from './use-guide';
import { useMobilePanel } from '../../lib/use-mobile-panel';
import './guide.css';

interface Props {
  lang: GuideLang;
  view: View;
  sessionId: string | null;
  /** 跳页（App 的 `goView`：带上「进词条页清空搜索词」这类既有收尾） */
  onView: (v: View) => void;
  onNewSession: () => void;
  /** 请 App 切到对话页并回到「未选会话」态（随机话题要在那个态下开新会话） */
  onFreshChat: () => void;
}

export function GuideBeacon({ lang, view, sessionId, onView, onNewSession, onFreshChat }: Props) {
  const g = useGuide({ lang, view, sessionId });
  useMobilePanel(g.open, g.close);
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const [notice, setNotice] = useState('');

  // 壳层自己能做的动作：随时可用
  useGuideCaps({
    'session.new': onNewSession,
    'chat.topic': (text) => {
      if (!text) return;
      putGuideMail(text);
      const c = getGuideChat();
      // 已经停在一场空白会话里（ChatView 在）：话就在这间里发，别再开一间把它丢成孤儿
      if (c && c.sessionId !== null && c.empty) return;
      onFreshChat();
    },
    'nav.terms': () => onView('terms'),
    'nav.continent': () => onView('continent'),
    'nav.settings': () => onView('settings'),
    'nav.pk': () => {
      window.location.hash = PK_HASH;
    },
  });

  // 点弹层外面收起（同 ComposerMenu）
  useEffect(() => {
    if (!g.open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) g.close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [g.open, g.close]);

  // 用键盘展开的，焦点送进弹层（鼠标展开不抢焦点）；每次展开清掉上次的提示
  useEffect(() => {
    if (!g.open) return;
    setNotice('');
    if (keyboardOpen.current) popRef.current?.focus();
  }, [g.open]);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  const pick = (item: GuideItem): void => {
    if (!runGuideCap(item.kind, item.text)) {
      setNotice(T.unavailable[lang]);
      return;
    }
    setNotice('');
    g.done();
    // 处理器若已把焦点送走（如聊天输入框）就不动；焦点还困在刚收起的弹层里才还给提灯
    if (popRef.current?.contains(document.activeElement)) btnRef.current?.focus();
  };

  /** 「全部功能」里点某一行：没有 AI 写的文案，用目录默认文案与兜底文本 */
  const pickKind = (kind: GuideKind): void => {
    const info = GUIDE_CATALOG[kind];
    const text = GUIDE_TEXT_KINDS.includes(kind) ? defaultGuideText(kind, lang, g.seed) : undefined;
    pick({ kind, label: info.label[lang], hint: info.hint[lang], ...(text ? { text } : {}) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!g.open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      g.close();
      btnRef.current?.focus();
      return;
    }
    if (/^[1-4]$/.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const item = g.result.items[Number(e.key) - 1];
      if (item) {
        e.preventDefault();
        pick(item);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 跳过 display:none 的（桌面上手机专用的 ✕ 关闭钮）：对它 focus() 是空操作，焦点会卡在上一个元素上动不了
      const els = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? []).filter(
        (el) => getComputedStyle(el).display !== 'none',
      );
      if (els.length === 0) return;
      const at = els.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (at + 1) % els.length : at <= 0 ? els.length - 1 : at - 1;
      e.preventDefault();
      els[next]?.focus();
    }
  };

  // 快捷项（POMODORO-SPEC §9 / GUIDE-SPEC §8.1）：亮灯时提灯**正下方直接摆出第一条推荐**，一点即执行；
  // 点提灯本身才是整张清单。先是规则推荐、AI 回来原位换；亮灯那刻顺手预取，让 AI 版尽快到。
  const quick = useMemo<GuideItem | null>(() => g.result.items[0] ?? null, [g.result]);
  const [quickHidden, setQuickHidden] = useState<string | null>(null);
  const litKey = g.lit ? `${g.lit}|${g.teaser ?? ''}` : null;
  useEffect(() => {
    if (litKey) g.prefetch();
    // 每次新亮灯都重新露出快捷项（上次叉掉的是上次那条）
    setQuickHidden(null);
  }, [litKey]);
  const showQuick = !!g.teaser && !g.open && quickHidden !== litKey;

  const state = g.open ? 'open' : g.lit ? 'lit' : 'idle';
  return (
    <div className={`guide-beacon${g.open ? ' is-open' : ''}${g.lit ? ' is-lit' : ''}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={btnRef}
        type="button"
        className="guide-lantern"
        aria-label={T.label[lang]}
        title={T.label[lang]}
        aria-expanded={g.open}
        aria-controls={g.open ? uid : undefined}
        onClick={(e) => {
          keyboardOpen.current = e.detail === 0;
          g.toggle();
        }}
        onPointerEnter={() => {
          if (!g.open) hoverTimer.current = window.setTimeout(g.prefetch, GUIDE_HOVER_PREFETCH_MS);
        }}
        onPointerLeave={() => window.clearTimeout(hoverTimer.current)}
        onFocus={() => {
          if (!g.open) g.prefetch();
        }}
      >
        <Lantern state={state} />
        {g.lit && !g.open && <span className="guide-dot" aria-hidden="true" />}
      </button>
      {showQuick && (
        <div className="guide-quick">
          <span className="guide-teaser" aria-hidden="true">
            {g.teaser}
          </span>
          {quick && (
            <button
              type="button"
              className="guide-quick-btn"
              title={quick.text ? `${T.willSend[lang]}${quick.text}` : quick.hint}
              onClick={() => pick(quick)}
            >
              <b>{quick.label}</b>
              <small>{quick.hint}</small>
            </button>
          )}
          <button type="button" className="guide-quick-x" aria-label={T.close[lang]} title={T.close[lang]} onClick={() => setQuickHidden(litKey)}>
            ×
          </button>
        </div>
      )}
      {/* 读屏用：常驻的实时区，亮灯时才有字——实时区必须先于内容存在，播报才可靠 */}
      <span className="guide-sr" role="status">
        {g.teaser && !g.open ? g.teaser : ''}
      </span>
      {g.open && (
        <GuidePopover
          ref={popRef}
          id={uid}
          lang={lang}
          source={g.source}
          result={g.result}
          reason={g.reason}
          can={g.live.kinds}
          held={g.held}
          notice={notice}
          proactive={g.proactive}
          onPick={pick}
          onPickKind={pickKind}
          onRefresh={g.refresh}
          onApplyHeld={g.applyHeld}
          onTouch={g.touch}
          onClose={g.close}
          onProactive={g.setProactive}
        />
      )}
    </div>
  );
}
