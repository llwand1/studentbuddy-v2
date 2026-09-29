/**
 * features/continent/ExpandDialog — **开拓地块**弹窗（契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「开拓」）。
 *
 * 一次开拓的三幕：
 *   ① **领地**：一打开就 `POST /api/continent/expand/offer`（服务端按四邻的领域要一条新词条 + 出两道随机题型）；
 *   ② **先学**：把新词条与释义完整亮出来（它是用户没见过的词——不先看就答题是刁难，不是复习）；
 *   ③ **答题**：两道题逐道答，**答错不扣分、可重试**（与打怪同一条规矩，控件也同一份 `ContinentQuestionForm`）；
 *      全对 ⇒ `POST /claim`（服务端重判 + 落库 + 钉住）⇒ `onExpanded`。
 *
 * ★ `source:'fallback'` 必须**如实说**：模型没给出词时，这条来自内置词池（`fallbackReason` 原样念出来）——
 *   降级可以，假装没降级不行（同伙伴创建面板对 `source` 的处理）。
 * ★ 失败一律念出来、不吞：领不到词（409）/ 凭证过期（404）/ 落库失败 都留在弹窗里，并给"重新领一块"的路。
 */
import { useCallback, useEffect, useState } from 'react';
import { CONTINENT_QLABEL, gradeAnswer, type ContinentAnswer, type ContinentExpandOffer, type ContinentExpandResult } from '@sb/shared';
import { api } from '../../lib/api';
import { ContinentQuestionForm, correctText } from './ContinentQuestionForm';
import { cellLabel } from './continent-view';

interface Props {
  cell: { row: number; col: number };
  /** 开拓成功（新词条已落库并钉在这一格）：父组件重取地图 + 回话 */
  onExpanded: (result: ContinentExpandResult, offer: ContinentExpandOffer) => Promise<void> | void;
  onClose: () => void;
}

type Phase = 'offering' | 'learn' | 'quiz';

export function ExpandDialog({ cell, onExpanded, onClose }: Props) {
  const [offer, setOffer] = useState<ContinentExpandOffer | null>(null);
  const [phase, setPhase] = useState<Phase>('offering');
  const [error, setError] = useState<string | null>(null);
  const [qi, setQi] = useState(0);
  const [answers, setAnswers] = useState<ContinentAnswer[]>([]);
  const [answer, setAnswer] = useState<ContinentAnswer | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** ① 领地（打开即领；"重新领一块"也走这里） */
  const fetchOffer = useCallback(async () => {
    setPhase('offering');
    setError(null);
    setNote(null);
    setQi(0);
    setAnswers([]);
    setAnswer(null);
    try {
      const o = await api.terms.expandOffer(cell.row, cell.col);
      setOffer(o);
      setPhase('learn');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [cell.row, cell.col]);

  useEffect(() => {
    void fetchOffer();
  }, [fetchOffer]);

  const questions = offer?.questions ?? [];
  const current = questions[qi];

  /** ③ 提交当前题：错 ⇒ 亮答案可重试；对 ⇒ 下一题；最后一题对 ⇒ 交给服务端落地 */
  const submit = async (): Promise<void> => {
    if (!offer || !current || busy || answer === null) return;
    if (!gradeAnswer(current, answer)) {
      setNote(`还不对。${correctText(current)}`);
      return;
    }
    const all = [...answers, answer];
    if (qi + 1 < questions.length) {
      setAnswers(all);
      setQi(qi + 1);
      setAnswer(null);
      setNote(null);
      return;
    }
    setBusy(true);
    try {
      const r = await api.terms.expandClaim(offer.nonce, all);
      await onExpanded(r, offer);
    } catch (e) {
      // 凭证过期 / 这格刚被占 / 词已在库里：话原样念出来，并留"重新领一块"这条路
      setNote(`没落成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const sourceText = offer
    ? offer.source === 'ai'
      ? `由模型按邻近领域「${offer.domain}」现生成`
      : `${offer.fallbackReason ?? '没有可用的模型，这条来自内置词池'} · 领域「${offer.domain}」`
    : '';

  return (
    <div className="continent-modal" role="dialog" aria-modal="true" aria-label="开拓新地块">
      <div className="continent-modal-card">
        <header className="continent-modal-head">
          <span className="continent-modal-title">
            开拓新地块
            <small>
              {cellLabel(cell)} · 答对 {questions.length || 2} 道题，新地块就长在这一格
            </small>
          </span>
          <button className="continent-btn ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        {phase === 'offering' && !error && <p className="continent-banner dim">正在为这块地挑一条新词条…</p>}

        {error && (
          <>
            <p className="continent-banner warn">{error}</p>
            <footer className="continent-modal-foot">
              <button className="continent-btn primary" onClick={() => void fetchOffer()}>
                再试一次
              </button>
            </footer>
          </>
        )}

        {offer && phase === 'learn' && (
          <>
            {/* ② 先学：新词条完整亮出来（用户没见过它，先看再答） */}
            <div className="continent-expand-card">
              <b>{offer.term}</b>
              <p className="continent-detail-def">{offer.definition}</p>
              <small className={offer.source === 'fallback' ? 'continent-expand-source fallback' : 'continent-expand-source'}>
                {sourceText}
              </small>
            </div>
            <p className="continent-note">
              接下来两道题：{questions.map((q) => CONTINENT_QLABEL[q.type]).join(' + ')}。答错不扣分，可重答。
            </p>
            <footer className="continent-modal-foot">
              <button className="continent-btn ghost" onClick={() => void fetchOffer()}>
                换一条
              </button>
              <button className="continent-btn primary" onClick={() => setPhase('quiz')}>
                记住了，开始答题
              </button>
            </footer>
          </>
        )}

        {offer && phase === 'quiz' && (
          <>
            <div className="continent-hp">
              {questions.map((q, i) => (
                <span key={`${q.type}-${i}`} className={i >= qi ? 'continent-hp-dot on' : 'continent-hp-dot'} title={CONTINENT_QLABEL[q.type]} />
              ))}
              <em>
                第 {Math.min(qi + 1, questions.length)} / {questions.length} 题 · 词条「{offer.term}」
              </em>
            </div>
            {current && <ContinentQuestionForm key={qi} q={current} answer={answer} onChange={setAnswer} onEnter={() => void submit()} />}
            {note && <p className="continent-note">{note}</p>}
            <footer className="continent-modal-foot">
              <button className="continent-btn ghost" disabled={busy} onClick={() => setPhase('learn')}>
                再看一眼释义
              </button>
              {note?.startsWith('没落成') && (
                <button className="continent-btn ghost" disabled={busy} onClick={() => void fetchOffer()}>
                  重新领一块
                </button>
              )}
              <button className="continent-btn primary" disabled={busy || answer === null} onClick={() => void submit()}>
                {qi + 1 >= questions.length ? '落地！' : '提交'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
