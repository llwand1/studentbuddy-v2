/**
 * QuizImageCard — 出题配图总开关（契约 docs/QUIZ-IMAGE-SPEC.md §2.2）。
 * 双层决定：本开关是用户总闸（关 → 明令模型不输出 svg）；开 → 由模型自决哪题需要配图。
 * 点选即存（无独立保存按钮）：设置只有两个取值，多余的一步只会增加「改了没存」的困惑。
 */
import { useEffect, useState } from 'react';
import { DEFAULT_QUIZ_IMAGE } from '@sb/shared';
import { api } from '../../lib/api';
import './settings.css';

export function QuizImageCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [on, setOn] = useState(DEFAULT_QUIZ_IMAGE);
  const [saved, setSaved] = useState(DEFAULT_QUIZ_IMAGE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings
      .quizImage()
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
      const r = await api.settings.saveQuizImage(next);
      setOn(r.on);
      setSaved(r.on);
      flash(true, r.on ? '已开启：需要示意图的题会配 SVG' : '已关闭：出题保持纯文字');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const state = loading ? '读取中…' : busy ? '保存中…' : `当前：${on ? '开启' : '关闭'}`;

  return (
    <section className="settings-sec">
      <h3>出题配图</h3>
      <p className="settings-hint">
        开启后，模型只对「靠文字说不清」的题附一张 SVG 示意图——几何图形、电路、实验装置、流程、结构等；
        文字说得清的题不配图，不为凑数画图。配图会明显拉长模型输出，<b>弱模型建议关闭</b>。
        本设置只对下一次出题生效，已出过的题不变。
      </p>

      <div className="quiz-mix-presets">
        <button
          className={on ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
          disabled={loading || busy}
          onClick={() => void pick(true)}
        >
          开启配图
        </button>
        <button
          className={!on ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
          disabled={loading || busy}
          onClick={() => void pick(false)}
        >
          关闭（纯文字）
        </button>
      </div>

      <div className="settings-actions">
        <span className={on ? 'settings-state on' : 'settings-state'}>{state}</span>
      </div>
    </section>
  );
}
