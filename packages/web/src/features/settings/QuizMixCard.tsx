/**
 * QuizMixCard — 出题题型配比设置：预设快选 + 逐题型题数微调（每档 0 起，0 = 不出）。
 * 数量既能 +/− 步进，也能**直接输入数字**（直输与步进共用同一套钳位：shared `setQuizMix`/`stepQuizMix`）。
 * 全局一份落服务端 app_settings：对话页「出题」与题库页「一键出题」共用同一配比。
 * 上限由 shared 契约给（单题型 10 / 总 20），本卡只做钳位与如实展示，不自己定规则。
 */
import { useEffect, useState } from 'react';
import type { QuizMix, QuizType } from '@sb/shared';
import {
  QUIZ_TYPES,
  QUIZ_TYPE_LABELS,
  DEFAULT_QUIZ_MIX,
  MAX_QUIZ_PER_TYPE,
  MAX_QUIZ_TOTAL,
  mixTotal,
  stepQuizMix,
  setQuizMix,
} from '@sb/shared';
import { api } from '../../lib/api';
import './settings.css';

const PRESETS: Array<{ name: string; mix: QuizMix }> = [
  { name: '标准 4 题', mix: { single: 2, multiple: 0, fill: 1, essay: 1 } },
  { name: '全选择 5 题', mix: { single: 5, multiple: 0, fill: 0, essay: 0 } },
  { name: '选择+多选 5 题', mix: { single: 3, multiple: 2, fill: 0, essay: 0 } },
  { name: '笔试 10 题', mix: { single: 4, multiple: 2, fill: 2, essay: 2 } },
];

const sameMix = (a: QuizMix, b: QuizMix): boolean => QUIZ_TYPES.every((t) => a[t] === b[t]);

export function QuizMixCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [mix, setMix] = useState<QuizMix>({ ...DEFAULT_QUIZ_MIX });
  const [saved, setSaved] = useState<QuizMix>({ ...DEFAULT_QUIZ_MIX });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings
      .quizMix()
      .then((r) => {
        setMix(r.mix);
        setSaved(r.mix);
      })
      .catch((e) => flash(false, e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const total = mixTotal(mix);
  const dirty = !sameMix(mix, saved);
  const activePreset = PRESETS.find((p) => sameMix(p.mix, mix))?.name ?? '';
  const totalFull = total >= MAX_QUIZ_TOTAL;

  /** 加减档位：钳位规则在 shared（stepQuizMix），本组件只管调，不自己定规则 */
  const bump = (t: QuizType, delta: number) => {
    setMix((m) => stepQuizMix(m, t, delta));
  };

  /** 数字直输：同一套钳位规则（setQuizMix），输入 12 / 负数 / 顶破总上限都按编辑态规则收口 */
  const bumpTo = (t: QuizType, value: number) => {
    setMix((m) => setQuizMix(m, t, value));
  };

  const save = async () => {
    if (total === 0 || busy) return;
    setBusy(true);
    try {
      const r = await api.settings.saveQuizMix(mix);
      setMix(r.mix);
      setSaved(r.mix);
      flash(true, `已保存：每次出题共 ${mixTotal(r.mix)} 题`);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-sec">
      <h3>出题题型配比</h3>
      <p className="settings-hint">
        决定每次出题各题型各来几道（0 = 不出该题）；对话页「出题」与题库页「一键出题」都按这份配比。模型偶尔出不够，会在出题处如实提示缺哪类。
      </p>

      <div className="quiz-mix-presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            className={activePreset === p.name ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
            disabled={loading || busy}
            onClick={() => setMix({ ...p.mix })}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="quiz-mix-rows">
        {QUIZ_TYPES.map((t) => (
          <QuizMixRow
            key={t}
            label={QUIZ_TYPE_LABELS[t]}
            value={mix[t]}
            total={total}
            disabled={loading || busy}
            onStep={(delta) => bump(t, delta)}
            onSet={(v) => bumpTo(t, v)}
          />
        ))}
      </div>

      <div className="settings-actions">
        <button className="settings-add" disabled={loading || busy || total === 0 || !dirty} onClick={() => void save()}>
          {busy ? '保存中…' : '保存配比'}
        </button>
        <button
          className="settings-test"
          disabled={loading || busy}
          onClick={() => setMix({ ...DEFAULT_QUIZ_MIX })}
        >
          恢复默认
        </button>
        <span className="quiz-mix-total">
          {total === 0
            ? '共 0 题（至少留 1 题）'
            : `共 ${total} 题 · 总上限 ${MAX_QUIZ_TOTAL}${totalFull ? '，已满（先减后加）' : ''}`}
        </span>
      </div>
    </section>
  );
}

/**
 * 单题型一行：− / 数字直输 / +。数字框用本地 draft（字符串），失焦或回车才提交，
 * 避免每次按键都重算导致光标跳动；提交走 shared `setQuizMix` 钳位，钳位后的最终值由
 * 父组件 value 回灌（useEffect 同步 draft），输入超限数字会自动"回落"到合法值。
 */
function QuizMixRow({
  label,
  value,
  total,
  disabled,
  onStep,
  onSet,
}: {
  label: string;
  value: number;
  total: number;
  disabled: boolean;
  onStep: (delta: number) => void;
  onSet: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // 父级 mix 变化（点预设 / 点 +− / 保存回读 / 输入被钳位）时，把输入框同步回真实值
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const perTypeFull = value >= MAX_QUIZ_PER_TYPE;
  const totalFull = total >= MAX_QUIZ_TOTAL;

  /** 失焦/回车提交：无效输入还原为当前值；有效输入本地先规范化，再交给钳位规则 */
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      setDraft(String(value));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    setDraft(String(Math.trunc(n)));
    onSet(n);
  };

  return (
    <div className="quiz-mix-row">
      <span>{label}</span>
      <button className="quiz-mix-step" disabled={disabled || value <= 0} onClick={() => onStep(-1)} title="减少">
        −
      </button>
      <input
        className="quiz-mix-num"
        type="number"
        min={0}
        max={MAX_QUIZ_PER_TYPE}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            e.currentTarget.blur();
          }
        }}
      />
      <button
        className="quiz-mix-step"
        disabled={disabled || perTypeFull || totalFull}
        onClick={() => onStep(1)}
        title={
          perTypeFull
            ? `单题型上限 ${MAX_QUIZ_PER_TYPE} 道`
            : totalFull
              ? `总题数已达上限 ${MAX_QUIZ_TOTAL} 道，先减掉别的题型再加`
              : '增加'
        }
      >
        +
      </button>
      <span className="settings-state">0 = 不出</span>
      <span className="settings-state">{perTypeFull ? '已达单题型上限' : `单题型上限 ${MAX_QUIZ_PER_TYPE}`}</span>
    </div>
  );
}
