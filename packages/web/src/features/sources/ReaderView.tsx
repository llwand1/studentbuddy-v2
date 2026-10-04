/**
 * ReaderView —— 侧栏阅读器（契约 `docs/SOURCE-TRACE-SPEC.md` §14）。取代网页类资料的 iframe 那一格。
 *
 * 它同时解决两件原来做不到的事：
 *  ① **页内跳转不再跳出本站**（§14.2）：正文里的链接点下去先弹确认条「要去 example.com 吗」，
 *     点头才登记许可（`POST /api/sources/follow`）并在**本面板内**翻页；面板自己维护返回栈。
 *     刻意保留「新标签页」那一路——有人就是想甩出去看，不该把这条路堵死。
 *  ② **划线三件事**（§14.3/§14.4）：选区浮出工具条 → 讲解 / 出题 / 存词条。
 *     三者都带「选中句 + 所在章节 + 出处」，由 `buildReaderSelection` 统一预算，不是只送一句话。
 *
 * ★ 阅读内容走 `ReaderBlocks`（React 元素，零 `dangerouslySetInnerHTML`），所以选区就在主文档里，
 *   不必向 iframe 注入任何脚本——契约 §9「阅读页零脚本」原样保留。
 * ★ 浮条位置走 CSS 变量（`--rd-x/--rd-y`），由 ref 上 `setProperty` 写入——web 侧内联样式是 gates 红线，
 *   手法与 `features/chat/QuoteAsk.tsx` 的小牌定位完全一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildReaderSelection, type ReaderSelection, type SourceItem } from '@sb/shared';
import { followSource, readReaderPage } from '../../lib/api-sources';
import {
  askFollow,
  getReaderNav,
  cancelFollow,
  commitFollow,
  readerBack,
  readerLoaded,
  readerNotice,
  startReading,
  useReaderNav,
} from '../../lib/reader-store';
import { ReaderBlocks } from './ReaderBlocks';
import { openLookup } from '../lookup/lookup-store';
import { clampToolbar, readReaderSelection, type ReaderHit } from './reader-selection';
import './sources.css';

const DEBOUNCE_MS = 180;

export function ReaderView({ sessionId, item }: { sessionId: string; item: SourceItem }) {
  const nav = useReaderNav();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hit, setHit] = useState<ReaderHit | null>(null);
  const [acting, setActing] = useState('');
  const toolsRef = useRef<HTMLDivElement>(null);

  // 面板切到这条资料 ⇒ 一次全新的阅读（历史清空，见 reader-store 口径 ③）
  useEffect(() => {
    startReading(sessionId, item.url, item.title);
  }, [sessionId, item.url, item.title]);

  // 取页：url 变（含点进去的新页、返回上一页）就重取
  const { url } = nav;
  useEffect(() => {
    if (!url || !sessionId) return;
    const ac = new AbortController();
    // 标题从 store 现取而不是从闭包捞：它会随取页结果回填，进了依赖就会多取一次
    readReaderPage(sessionId, url, getReaderNav().title, ac.signal).then(
      (p) => {
        if (!ac.signal.aborted) readerLoaded(url, p);
      },
      () => {
        if (!ac.signal.aborted) readerNotice('这一页没取回来，可以点「原网页」在新标签页看');
      },
    );
    return () => ac.abort();
  }, [sessionId, url]);

  // 选区 → 浮条（同 QuoteAsk：selectionchange 去抖 + 塌缩即收起）
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = (): void => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setHit(readReaderSelection(bodyRef.current)), DEBOUNCE_MS);
    };
    document.addEventListener('selectionchange', on);
    return () => {
      if (t) clearTimeout(t);
      document.removeEventListener('selectionchange', on);
    };
  }, []);

  // 面板内滚动 ⇒ 收浮条（fixed 定位不跟着选区走，留着会飘在错位置）
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const on = (): void => setHit(null);
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  }, []);

  /** 组装送进三个动作的那份材料：选中句 + 所在章节 + 出处 */
  const selectionOf = useCallback(
    (h: ReaderHit): ReaderSelection | null => {
      const page = nav.page;
      if (!page || !page.ok) return null;
      return buildReaderSelection({ blocks: page.blocks, blockIds: h.blockIds, selected: h.text, sourceTitle: page.title, sourceUrl: page.url });
    },
    [nav.page],
  );

  /**
   * 划线动作：统一**开速查小窗**，不碰对话（LOOKUP-SPEC §1）。
   * 上一版把提示词塞进输入框，既污染主对话、又让"选区丢没丢"不可见——实测就栽在这。
   * 现在三个动作都在小窗里完成，划中的原文还会原样显示在窗口顶部，一眼可查。
   */
  const act = (kind: 'explain' | 'quiz' | 'term'): void => {
    if (!hit) return;
    const sel = selectionOf(hit);
    const anchor = { x: hit.x, y: hit.y };
    setHit(null);
    if (!sel) {
      setActing('这段没取到原文，换一段再划一次');
      return;
    }
    openLookup(
      { text: sel.text, heading: sel.heading, section: sel.section, sourceTitle: sel.sourceTitle, sourceUrl: sel.sourceUrl },
      anchor.x,
      anchor.y,
      kind === 'term' ? 'wiki' : kind,
    );
  };

  /** 确认跳转：先登记许可，再在本面板内翻页 */
  const go = (): void => {
    const p = nav.pending;
    if (!p) return;
    followSource(sessionId, p.url).then(
      () => commitFollow(p.url, p.label || p.site),
      (e: unknown) => readerNotice(`跳不过去：${e instanceof Error ? e.message : '稍后再试'}`),
    );
  };

  const page = nav.page;

  // 浮条位置写成 CSS 变量（同 QuoteAsk）：web 侧内联样式是门禁红线
  useEffect(() => {
    const el = toolsRef.current;
    if (!el || !hit) return;
    const pos = clampToolbar(hit.x, hit.y, window.innerWidth, window.innerHeight);
    el.style.setProperty('--rd-x', `${Math.round(pos.x)}px`);
    el.style.setProperty('--rd-y', `${Math.round(pos.y)}px`);
  }, [hit]);

  return (
    <div className="rd-wrap">
      {nav.stack.length > 0 && (
        <div className="rd-bar">
          <button type="button" className="src-thin-btn" onClick={readerBack}>
            ← 返回
          </button>
          <span className="rd-bar-path" title={nav.url}>
            {nav.title}
          </span>
        </div>
      )}

      {/* 跳转确认：授权模型本身（§14.2）——每一次越界都对应一次明确的人类点击 */}
      {nav.pending && (
        <div className="rd-ask" role="alertdialog" aria-label="确认跳转">
          <span className="rd-ask-txt">
            要在侧栏打开 <b>{nav.pending.site}</b> 吗？
            <span className="rd-ask-url">{nav.pending.url}</span>
          </span>
          <button type="button" className="src-thin-btn" onClick={go}>
            在侧栏打开
          </button>
          <button type="button" className="src-thin-btn" onClick={() => window.open(nav.pending?.url ?? '', '_blank', 'noopener,noreferrer')}>
            新标签页 ↗
          </button>
          <button type="button" className="src-thin-btn" onClick={cancelFollow}>
            取消
          </button>
        </div>
      )}

      {nav.notice && <div className="rd-note">{nav.notice}</div>}
      {acting && (
        <div className="rd-note rd-acting" role="status">
          {acting}
          <button type="button" className="src-thin-btn" onClick={() => setActing('')}>
            知道了
          </button>
        </div>
      )}

      <div className="rd-body" ref={bodyRef} data-testid="reader-body">
        {nav.loading && <p className="rd-wait">读取中…</p>}
        {page && !page.ok && (
          <p className="rd-wait">
            阅读模式没打开这一页：{page.reason}。可以点右上角「原网页」。
          </p>
        )}
        {page && page.ok && (
          <article className="rd-article">
            <h1 className="rd-title">{page.title}</h1>
            {page.byline && <p className="rd-byline">{page.byline}</p>}
            {page.thin && <p className="rd-thin">这页正文主要靠脚本渲染，阅读模式只拿到一小部分。</p>}
            <ReaderBlocks blocks={page.blocks} onFollow={(href, label) => askFollow(href, label)} />
          </article>
        )}
      </div>

      {/* 划线浮条：位置走 CSS 变量（禁内联 style） */}
      {hit && (
        <div className="rd-tools" ref={toolsRef} onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className="rd-tool" onClick={() => act('explain')}>
            讲解
          </button>
          <button type="button" className="rd-tool" onClick={() => act('quiz')}>
            出题
          </button>
          <button type="button" className="rd-tool" onClick={() => act('term')}>
            查词条
          </button>
        </div>
      )}
    </div>
  );
}
