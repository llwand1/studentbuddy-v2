/**
 * QuizRealFirstCard — 真题优先开关（契约 docs/QUIZ-TIER-SPEC.md §4）。
 * 开（缺省）：没配真题配比时，出题也并行去公开题源摘真题，摘到几道就顶替几道同题型 AI 题，题数不变、不多等；
 * 关：完全回到「只按配比出题」。点选即存（同 QuizImageCard）。
 */
import { useEffect, useState } from 'react';
import { DEFAULT_QUIZ_REAL_FIRST } from '@sb/shared';
import { api } from '../../lib/api';
import './settings.css';

export function QuizRealFirstCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [on, setOn] = useState(DEFAULT_QUIZ_REAL_FIRST);
  const [saved, setSaved] = useState(DEFAULT_QUIZ_REAL_FIRST);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings
      .quizRealFirst()
      .then((r) => {
        setOn(r.on);
        setSaved(r.on);
      })
      .catch((e) => flash(false, e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const pick = async (next: boolean) => {
    if (busy || next === saved) return;
    setBusy(true);
    try {
      const r = await api.settings.saveQuizRealFirst(next);
      setOn(r.on);
      setSaved(r.on);
      flash(true, r.on ? '已开启：出题时优先摘公开题源的真题' : '已关闭：只按配比出题');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const state = loading ? '读取中…' : busy ? '保存中…' : `当前：${on ? '开启' : '关闭'}`;

  return (
    <section className="settings-sec">
      <h3>真题优先</h3>
      <p className="settings-hint">
        开启后，每次出题都会<b>并行</b>去公开题源搜集真题：题干与选项逐字经原文比对、带出处链接与题源配图；
        摘到几道就顶替几道同题型的 AI 题，<b>总题数不变、不额外等待</b>。每道题卡都会标注档位——
        「真题·必刷」「模拟题·建议做」「基础题·可选做」——让你先知道这题做了有什么用。
        网上摘不到时全部由 AI 出，不会用 AI 题冒充真题。
      </p>

      <div className="quiz-mix-presets">
        <button className={on ? 'quiz-mix-chip active' : 'quiz-mix-chip'} disabled={loading || busy} onClick={() => void pick(true)}>
          开启（推荐）
        </button>
        <button className={!on ? 'quiz-mix-chip active' : 'quiz-mix-chip'} disabled={loading || busy} onClick={() => void pick(false)}>
          关闭（只按配比）
        </button>
      </div>

      <div className="settings-actions">
        <span className={on ? 'settings-state on' : 'settings-state'}>{state}</span>
      </div>
    </section>
  );
}
