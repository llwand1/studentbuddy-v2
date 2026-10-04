/**
 * LookupPopup —— 划词速查小窗（契约 `docs/LOOKUP-SPEC.md`）。常驻应用壳层，一次只开一个。
 *
 * 它替换掉了上一版「把提示词塞进对话输入框」的做法。那个做法有两个硬伤：
 *   ① **污染主对话**：用户的会话里凭空多出一段他没打算问的长引用；
 *   ② **失败不可见**：选区如果在某一步丢了，用户看不出来，只会收到模型反问
 *      「你没有贴出具体划中的那句话」——这正是实测踩到的。
 * 小窗把两件事同时解决：答案不进会话；**划中的原文原样显示在窗口顶部**，
 * 所以"模型到底拿到了什么"是肉眼可查的，丢了一眼就看得见。
 *
 * ★ 顺序是「免费优先」：打开先查维基（不烧额度、通常一秒内回），
 *   查不到才把「让 AI 讲解」提为主按钮。术语类划选大多到此为止。
 * ★ 位置走 CSS 变量 + ref.setProperty（web 侧内联样式是门禁红线，同 QuoteAsk）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { pickLookupTerm, wikiLangFor, type LookupContext, type WikiLookup } from '@sb/shared';
import { api } from '../../lib/api';
import { lookupExplain, lookupQuiz, lookupWiki } from '../../lib/api-lookup';
import { closeLookup, useLookup } from './lookup-store';
import './lookup.css';

/** 小窗尺寸，夹取用（与 lookup.css 的 --lk-w 保持一致） */
const W = 380;
const H = 420;

function clampPopup(x: number, y: number, vw: number, vh: number): { x: number; y: number } {
  const half = W / 2;
  return {
    x: Math.min(Math.max(x, half + 8), Math.max(half + 8, vw - half - 8)),
    y: y + H + 12 > vh ? Math.max(8, y - H - 16) : y + 10,
  };
}

type Tab = 'wiki' | 'explain' | 'quiz';

export function LookupPopup() {
  const st = useLookup();
  const boxRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>('wiki');
  const [wiki, setWiki] = useState<WikiLookup | null>(null);
  const [ai, setAi] = useState<{ kind: Tab; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');

  const ctx: LookupContext | null = st.ctx;
  const term = ctx ? pickLookupTerm(ctx.text) : '';

  // 开窗即重置并自动查维基（免费优先）
  useEffect(() => {
    if (!st.open || !ctx) return;
    setTab(st.initial);
    setWiki(null);
    setAi(null);
    setErr('');
    setSaved('');
    if (!term) {
      // 划的是一整句 ⇒ 没有可查的词条，直接把 AI 讲解摆到前台（不猜词，猜错比没有更糟）
      setTab('explain');
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    lookupWiki(term, wikiLangFor(term), ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setWiki(r);
        // ★ 查不到**不切页签**：切走用户就再也看不到"为什么没查到"（那又是一次静默）。
        //   留在原处显示原因，并在原地给一枚「让 AI 讲讲」主按钮。
      })
      .catch(() => {
        if (!ac.signal.aborted) setWiki({ ok: false, reason: '维基百科没连上' });
      })
      .finally(() => {
        if (!ac.signal.aborted) setBusy(false);
      });
    return () => ac.abort();
  }, [st.open, st.initial, ctx, term]);

  // Esc 关窗
  useEffect(() => {
    if (!st.open) return;
    const on = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeLookup();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [st.open]);

  // 定位
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !st.open) return;
    const p = clampPopup(st.x, st.y, window.innerWidth, window.innerHeight);
    el.style.setProperty('--lk-x', `${Math.round(p.x)}px`);
    el.style.setProperty('--lk-y', `${Math.round(p.y)}px`);
  }, [st.open, st.x, st.y]);

  const runAi = useCallback(
    (kind: 'explain' | 'quiz') => {
      if (!ctx) return;
      setTab(kind);
      if (ai?.kind === kind) return; // 已经有结果就别重复烧额度
      setBusy(true);
      setErr('');
      const call = kind === 'explain' ? lookupExplain : lookupQuiz;
      call(ctx)
        .then((r) => (r.ok ? setAi({ kind, text: r.text }) : setErr(r.reason)))
        .catch((e: unknown) => setErr(e instanceof Error ? e.message : '没调通'))
        .finally(() => setBusy(false));
    },
    [ctx, ai],
  );

  /** 存词条：维基查到了就直接用它的标题+摘要（不烧额度），否则交给抽取接口 */
  const save = (): void => {
    if (!ctx) return;
    setSaved('正在存…');
    const p =
      wiki && wiki.ok
        ? api.terms.add(wiki.title, wiki.extract.slice(0, 300), '').then((t) => `已存入词条「${t.term}」`)
        : api.terms
            .extract([`【划选】${ctx.text}`, `【章节】${ctx.heading || '（无标题）'}`, ctx.section, `【出处】${ctx.sourceTitle} ${ctx.sourceUrl}`].join('\n'))
            .then((r) => (r.added > 0 ? `已收入 ${r.added} 条：${r.items.map((t) => t.term).join('、')}` : '这段里没抽到值得单独记的词条'));
    p.catch((e: unknown) => `没存上：${e instanceof Error ? e.message : '稍后再试'}`).then((m) => setSaved(String(m)));
  };

  if (!st.open || !ctx) return null;

  const body =
    tab === 'wiki' ? (
      wiki === null ? (
        <p className="lk-wait">正在查维基百科…</p>
      ) : wiki.ok ? (
        <>
          {wiki.redirected && <p className="lk-redir">你划的是「{term}」，维基给的是下面这个条目</p>}
          <h4 className="lk-h">{wiki.title}</h4>
          <p className="lk-text">{wiki.extract}</p>
          <a className="lk-src" href={wiki.url} target="_blank" rel="noreferrer noopener">
            看完整条目 ↗
          </a>
        </>
      ) : (
        <div className="lk-miss">
          <p className="lk-wait">{wiki.reason}。</p>
          <button type="button" className="lk-btn lk-primary" onClick={() => runAi('explain')}>
            让 AI 结合这页原文讲讲
          </button>
        </div>
      )
    ) : ai && ai.kind === tab ? (
      <p className="lk-text lk-ai">{ai.text}</p>
    ) : busy ? (
      <p className="lk-wait">AI 正在结合这页原文作答…</p>
    ) : (
      <p className="lk-wait">点上面的按钮开始。答案只出现在这个小窗里，不会进你的对话。</p>
    );

  return (
    <div className="lk-box" ref={boxRef} role="dialog" aria-label="划词速查" data-testid="lookup-popup">
      <header className="lk-head">
        <span className="lk-badge">速查</span>
        {/* 划中的原文原样显示：模型拿到了什么，这里一眼可查（上一版正是这里不可见才翻车） */}
        <span className="lk-quote" title={ctx.text}>
          {ctx.text}
        </span>
        <button type="button" className="lk-x" onClick={closeLookup} aria-label="关闭">
          ×
        </button>
      </header>

      <nav className="lk-tabs">
        <button type="button" className={tab === 'wiki' ? 'lk-tab on' : 'lk-tab'} disabled={!term} onClick={() => setTab('wiki')}>
          词条释义{term ? '' : '（划的是整句）'}
        </button>
        <button type="button" className={tab === 'explain' ? 'lk-tab on' : 'lk-tab'} onClick={() => runAi('explain')}>
          AI 讲解
        </button>
        <button type="button" className={tab === 'quiz' ? 'lk-tab on' : 'lk-tab'} onClick={() => runAi('quiz')}>
          出题
        </button>
      </nav>

      <div className="lk-body">{err ? <p className="lk-wait lk-err">{err}</p> : body}</div>

      <footer className="lk-foot">
        <button type="button" className="lk-btn" onClick={save}>
          存为词条
        </button>
        {saved && <span className="lk-saved">{saved}</span>}
        <span className="lk-note">{ctx.heading ? `来自「${ctx.heading}」` : ctx.sourceTitle}</span>
      </footer>
    </div>
  );
}
