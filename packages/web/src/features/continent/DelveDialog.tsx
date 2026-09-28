/**
 * features/continent/DelveDialog — 地块「追问」升级：写一句追问 → 贤者（AI）作答并出题 → 全对即升级。
 *
 * ★ 判分在服务端（`POST /api/continent/delve/finish`）：这里只收集作答，答错时服务端告诉哪几题错，
 *   可以改了再交，不扣任何东西（与打怪同一条「复习不是考试」口径）。
 * ★ 没绑定 AI 时服务端退到本地贤者（照释义作答 + 本地出题），`source: 'fallback'` 时如实说出来。
 */
import { useState } from 'react';
import { api } from '../../lib/api';
import type { DelveAsk } from '../../lib/api-continent';
import { tileLevelName, type ContinentTileView } from './continent-view';

interface Props {
  tile: ContinentTileView;
  onClose: () => void;
  /** 升级成功（父组件换存档 + 播金光） */
  onLeveled: (lv: number, world: NonNullable<Awaited<ReturnType<typeof api.continent.delveFinish>>['world']>) => void;
}

const SUGGEST = ['它和相近的概念有什么区别？', '能举一个生活里的例子吗？', '它最容易被误解的地方是什么？'];

export function DelveDialog({ tile, onClose, onLeveled }: Props) {
  const [question, setQuestion] = useState('');
  const [ask, setAsk] = useState<DelveAsk | null>(null);
  const [answers, setAnswers] = useState<Array<number | boolean | null>>([]);
  const [wrong, setWrong] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.continent.delve(tile.row, tile.col, question.trim());
      setAsk(r);
      setAnswers(r.questions.map(() => null));
      setWrong([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.continent.delveFinish(tile.row, tile.col, answers);
      if (r.passed && r.world && typeof r.lv === 'number') {
        onLeveled(r.lv, r.world);
        return;
      }
      setWrong(r.wrong);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setAt = (i: number, v: number | boolean): void => {
    setAnswers((a) => a.map((x, j) => (j === i ? v : x)));
    setWrong((w) => w.filter((j) => j !== i));
  };

  return (
    <div className="continent-modal" role="dialog" aria-modal="true" aria-label={`追问 ${tile.term}`}>
      <div className="continent-modal-card continent-delve">
        <header className="continent-modal-head">
          <span className="continent-modal-title">
            深入研习 · {tile.term}
            <small>
              {tileLevelName(tile.lv)}（{tile.lv} 级）→ {tileLevelName(tile.lv + 1)}（{tile.lv + 1} 级）· 追问并答完随后的问答即可升级
            </small>
          </span>
          <button className="continent-btn ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        {!ask && (
          <div className="continent-delve-ask">
            <p className="continent-detail-def">{tile.definition}</p>
            <textarea
              className="continent-input"
              rows={3}
              maxLength={200}
              value={question}
              placeholder="就这条词条追问一句你真想知道的（至少 4 个字）"
              onChange={(e) => setQuestion(e.target.value)}
            />
            <div className="continent-delve-suggest">
              {SUGGEST.map((s) => (
                <button key={s} type="button" className="continent-btn ghost" onClick={() => setQuestion(s)}>
                  {s}
                </button>
              ))}
            </div>
            <button className="continent-btn primary" disabled={busy || question.trim().length < 4} onClick={() => void send()}>
              {busy ? '贤者正在翻书…' : '向贤者追问'}
            </button>
          </div>
        )}

        {ask && (
          <div className="continent-delve-body">
            <p className="continent-delve-answer">
              <b>{ask.source === 'ai' ? '贤者答：' : '本地贤者答：'}</b>
              {ask.answer}
            </p>
            {ask.source === 'fallback' && (
              <p className="continent-ember-hint">还没有绑定 AI 服务商，这次是照词条释义作答、本地出题；在「设置」里绑定后，追问会得到真正的解答。</p>
            )}
            <ol className="continent-delve-quiz">
              {ask.questions.map((q, i) => (
                <li key={i} className={wrong.includes(i) ? 'wrong' : ''}>
                  <p>{q.type === 'judge' ? `${q.prompt}：${q.statement}` : q.prompt}</p>
                  <div className="continent-delve-opts">
                    {q.type === 'judge'
                      ? ([true, false] as const).map((v) => (
                          <button key={String(v)} type="button" className={answers[i] === v ? 'continent-btn primary' : 'continent-btn'} onClick={() => setAt(i, v)}>
                            {v ? '对' : '错'}
                          </button>
                        ))
                      : q.options.map((o, j) => (
                          <button key={j} type="button" className={answers[i] === j ? 'continent-btn primary' : 'continent-btn'} onClick={() => setAt(i, j)}>
                            {o}
                          </button>
                        ))}
                  </div>
                </li>
              ))}
            </ol>
            {wrong.length > 0 && <p className="continent-banner warn">第 {wrong.map((i) => i + 1).join('、')} 题还不对——回头再读一遍贤者的回答，改了再交。</p>}
            <button className="continent-btn primary" disabled={busy || answers.some((a) => a === null)} onClick={() => void finish()}>
              交卷升级
            </button>
          </div>
        )}
        {error && <p className="continent-banner warn">{error}</p>}
      </div>
    </div>
  );
}
