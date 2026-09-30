import { useEffect, useRef, useState } from 'react';
import type { QuizExplanation, QuizReviewItem } from '@sb/shared';
import { api } from '../../lib/api';
import { Markdown } from '../chat/Markdown';
import { SvgPreviewCard } from '../chat/SvgPreviewCard';
import { prepareSvg } from '../../lib/svg-utils';

/**
 * 普通题与情景题共用完成/复盘面板。图文讲解仅保留于当前打开的卡片；
 * `recorded`＝这张卡的对错已记在服务端（普通题卡带 quizId 时，2026-09-30），底部那行提示据此改口。
 */
export function QuizReview({ sessionId, title, kind, items, total, onRetry, recorded = false }: {
  sessionId?: string | null; title: string; kind: 'quiz' | 'scenario';
  items: QuizReviewItem[]; total: number; onRetry?: () => void; recorded?: boolean;
}) {
  const [explanation, setExplanation] = useState<QuizExplanation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [open, setOpen] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
  const complete = total > 0 && items.length === total;
  const load = async () => {
    if (controller.current || !sessionId || !complete) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    setBusy(true); setError(''); setCancelled(false); setOpen(true);
    try {
      const result = await api.request<QuizExplanation>('/api/quiz/explain', {
        method: 'POST', body: JSON.stringify({ sessionId, title, kind, items }), signal: ctrl.signal, timeoutMs: 190_000,
      });
      if (ctrl.signal.aborted || controller.current !== ctrl) return;
      if (!result.sections.length || result.sections.some((part) => {
        if (!/<text\b/i.test(part.svg) || !/<(?:path|rect|circle|line|ellipse|polygon|polyline)\b/i.test(part.svg)) return true;
        const raw = new DOMParser().parseFromString(part.svg, 'image/svg+xml');
        if (raw.querySelector('parsererror')) return true;
        const safe = prepareSvg(part.svg);
        const doc = new DOMParser().parseFromString(safe, 'image/svg+xml');
        return !!doc.querySelector('parsererror') || !doc.querySelector('svg text')
          || !doc.querySelector('svg path, svg rect, svg circle, svg line, svg ellipse, svg polygon, svg polyline');
      })) throw new Error('讲解中的图示没有完整生成，请重试。');
      setExplanation(result);
      contentRef.current?.focus();
    } catch (e) {
      if (controller.current === ctrl && !ctrl.signal.aborted) setError(e instanceof Error ? e.message : '讲解生成失败，请重试。');
    } finally {
      if (controller.current === ctrl) { controller.current = null; setBusy(false); }
    }
  };
  const correct = items.filter((i) => i.verdict === 'correct').length;
  const review = items.filter((i) => i.verdict === 'review').length;
  return <section className={`quiz-review${complete ? ' is-complete' : ''}`} aria-label="练习进度与复盘">
    <div className="quiz-progress-label" role="status">
      <strong>{complete ? '本轮探索完成' : '探索进度'}</strong><span>{items.length} / {total}</span>
    </div>
    <progress className="quiz-progress" value={items.length} max={Math.max(1, total)} aria-label="已完成题目" />
    {complete ? <>
      <p className="quiz-review-counts">✓ {correct} 项答案吻合 · ↗ {items.length - correct - review} 项值得回看{review > 0 ? ` · ◇ ${review} 项待对照` : ''}</p>
      <p className="quiz-muted">作答结束，再把原理看明白。图文讲解会结合你的答案，画出关键关系与解题步骤。</p>
      <div className="quiz-review-actions">
        {!explanation && <button className="quiz-submit" disabled={busy || !sessionId} onClick={() => void load()}>
          {busy ? '正在梳理作答与绘制图解…' : error || cancelled ? '重新生成图文讲解' : '一键讲解 · 图文复盘'}
        </button>}
        {busy && <button className="quiz-gen-btn" onClick={() => {
          controller.current?.abort(); controller.current = null; setBusy(false); setCancelled(true);
        }}>取消生成</button>}
        {explanation && <button className="quiz-gen-btn" onClick={() => setOpen((v) => !v)}>{open ? '收起讲解' : '展开图文讲解'}</button>}
        {onRetry && !busy && <button className="quiz-gen-btn" onClick={onRetry}>再练一遍</button>}
      </div>
      {!sessionId && <p className="quiz-muted">请在会话中打开本组练习以生成讲解。</p>}
      {busy && <div className="quiz-review-loading" role="status"><span className="quiz-pixel-loader" aria-hidden="true">◆ ◆ ◆</span>
        正在连接题解模型、分析作答并绘图，可能需要一两分钟。</div>}
      {cancelled && <p role="status">已取消生成，作答仍保留，可以重试。</p>}
      {error && <p className="quiz-review-error" role="alert">{error}</p>}
      <div ref={contentRef} tabIndex={-1} className="quiz-review-content">
        {explanation && open && <>
          <h3>看懂这一轮</h3><Markdown text={explanation.summary} />
          {explanation.sections.map((part, i) => <section className="quiz-lesson" key={i}>
            <span className="quiz-q-type">图解 {i + 1} · 第 {part.questions.join('、')} 题</span>
            <h4>{part.title}</h4>
            <Markdown text={part.explanation} />
            <figure><SvgPreviewCard code={part.svg} streaming={false} /><figcaption>{part.caption}</figcaption></figure>
          </section>)}
          <div className="quiz-transfer"><h4>换个条件，你还会吗？</h4><Markdown text={explanation.transfer.question} />
            <details><summary>想一想，再查看参考思路</summary><Markdown text={explanation.transfer.answer} /></details>
          </div>
        </>}
      </div>
      <p className="quiz-local-note">{recorded
        ? '对错已记在这组题上（重开会话能看到刷过几遍、正确率）；图文讲解只保留在当前页面。'
        : '本轮作答和讲解保留在当前页面，刷新后需重新作答。'}</p>
    </> : <p className="quiz-muted">完成全部{kind === 'quiz' ? '题目' : '任务'}后，解锁这一轮的图文讲解。</p>}
  </section>;
}
