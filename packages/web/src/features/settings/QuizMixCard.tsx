/**
 * QuizMixCard — 出题题型配比（**双列**：每题型各配 AI 出题几道 / 网络真题几道）。
 * 契约 `docs/QUIZ-BLEND-SPEC.md` §2（2026-09-20 老板拍板 D2「按题型分别配」——不是一维总比例）。
 *
 * 职责边界：本卡**只做编排**——步进器交互拆在 `QuizMixRow.tsx`（`MixStepper`），
 * 钳位规则全在 shared（`stepQuizMix`/`setQuizMix` 与真题侧 `stepQuizSourceMix`/`setQuizSourceMix`），
 * 本卡不自己定规则。联合口径：AI 题 + 真题 ≤ `MAX_QUIZ_TOTAL`（20，拍板 D4 合并上限）。
 *
 * 保存顺序铁律：**先存 AI 侧、再存真题侧**——服务端两侧 PUT 各自对**库里的**另一侧做联合钳位
 * （`routes/settings.ts`），先 AI 后真题才能让真题侧按新 AI 配比收口；倒过来会按旧 AI 配比钳。
 *
 * 每账号一份落 app_settings（`quiz_mix` / `quiz_source_mix` 两键）：读它的是**对话页的出题**
 * （输入框「出题」不带 mix 时由服务端回落到这份，聊天工具 `generate-quiz` 同理）。
 * ★ 对战出题**不吃这份配比**——它按 `PK_QUIZ_MIX` 现算（`pk/match.ts`、`pk/ai-bot.ts`），
 *   所以这张卡从 2026-09-26 起只服务对话核一处；题库页那处入口同批下线。账号之间互不影响。
 */
import { useEffect, useState } from 'react';
import type { QuizMix, QuizMixKind, QuizSourceMix } from '@sb/shared';
import {
  MIX_KINDS,
  MIX_KIND_LABELS,
  DEFAULT_QUIZ_MIX,
  DEFAULT_QUIZ_SOURCE_MIX,
  MAX_QUIZ_TOTAL,
  mixKindCap,
  sourceKindCap,
  sourceMixTotal,
  blendTotal,
  normalizeQuizSourceMix,
  stepQuizMix,
  setQuizMix,
  stepQuizSourceMix,
  setQuizSourceMix,
} from '@sb/shared';
import { api } from '../../lib/api';
import { MixStepper } from './QuizMixRow';
import './settings.css';

const PRESETS: Array<{ name: string; mix: QuizMix }> = [
  { name: '标准 4 题', mix: { single: 2, multiple: 0, fill: 1, essay: 1, judge: 0, scenario: 0 } },
  { name: '全选择 5 题', mix: { single: 5, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 } },
  { name: '选择+多选 5 题', mix: { single: 3, multiple: 2, fill: 0, essay: 0, judge: 0, scenario: 0 } },
  { name: '笔试 10 题', mix: { single: 4, multiple: 2, fill: 2, essay: 2, judge: 0, scenario: 0 } },
  { name: '情景演练 2 套', mix: { single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 2 } },
];

const sameMix = (a: QuizMix, b: QuizMix): boolean => MIX_KINDS.every((t) => a[t] === b[t]);
const sameSource = (a: QuizSourceMix, b: QuizSourceMix): boolean => MIX_KINDS.every((t) => a[t] === b[t]);

export function QuizMixCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [mix, setMix] = useState<QuizMix>({ ...DEFAULT_QUIZ_MIX });
  const [saved, setSaved] = useState<QuizMix>({ ...DEFAULT_QUIZ_MIX });
  const [sourceMix, setSourceMix] = useState<QuizSourceMix>({ ...DEFAULT_QUIZ_SOURCE_MIX });
  const [savedSource, setSavedSource] = useState<QuizSourceMix>({ ...DEFAULT_QUIZ_SOURCE_MIX });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.settings.quizMix(), api.settings.quizSourceMix()])
      .then(([a, b]) => {
        setMix(a.mix);
        setSaved(a.mix);
        setSourceMix(b.mix);
        setSavedSource(b.mix);
      })
      .catch((e) => flash(false, e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const realTotal = sourceMixTotal(sourceMix);
  const blend = blendTotal(mix, sourceMix);
  const dirty = !sameMix(mix, saved) || !sameSource(sourceMix, savedSource);
  const activePreset = PRESETS.find((p) => sameMix(p.mix, mix))?.name ?? '';
  const totalFull = blend >= MAX_QUIZ_TOTAL;

  /** AI 列加减：钳位规则在 shared（stepQuizMix），本组件只管调 */
  const bumpAi = (t: QuizMixKind, delta: number) => setMix((m) => stepQuizMix(m, t, delta));
  /** AI 列数字直输：同一套钳位规则（setQuizMix） */
  const setAi = (t: QuizMixKind, value: number) => setMix((m) => setQuizMix(m, t, value));
  /** 真题列加减：联合钳位（stepQuizSourceMix）——真题能配几道取决于 AI 侧占掉多少额度 */
  const bumpReal = (t: QuizMixKind, delta: number) => setSourceMix((r) => stepQuizSourceMix(r, mix, t, delta));
  /** 真题列数字直输：同一套联合钳位（setQuizSourceMix） */
  const setReal = (t: QuizMixKind, value: number) => setSourceMix((r) => setQuizSourceMix(r, mix, t, value));

  const save = async () => {
    if (blend === 0 || busy) return;
    setBusy(true);
    try {
      // 顺序铁律（见文件头）：先 AI 后真题——真题侧按新 AI 配比联合钳位收口
      const r1 = await api.settings.saveQuizMix(mix);
      const r2 = await api.settings.saveQuizSourceMix(sourceMix);
      setMix(r1.mix);
      setSaved(r1.mix);
      setSourceMix(r2.mix);
      setSavedSource(r2.mix);
      flash(true, `已保存：每次出题共 ${blendTotal(r1.mix, r2.mix)} 题（其中真题 ${sourceMixTotal(r2.mix)} 题）`);
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
        决定每次出题各题型各来几道（0 = 不出）。真题从互联网现场搜集、逐字摘录并带出处链接；网上摘不到的题型会如实报缺，不用
        AI 顶替。情景题按「套」计——一套是一个可玩的交互 demo，网页上没有可摘录的同类物，故无真题列。
      </p>

      <div className="quiz-mix-presets">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            className={activePreset === p.name ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
            disabled={loading || busy}
            onClick={() => {
              setMix({ ...p.mix });
              // 预设只动 AI 列；真题列就地按新 AI 配比联合钳位（与保存时服务端口径一致，所见即所得）
              setSourceMix((r) => normalizeQuizSourceMix(r, p.mix));
            }}
          >
            {p.name}
          </button>
        ))}
      </div>

      <div className="quiz-mix-rows">
        <div className="quiz-mix-row quiz-mix-head" aria-hidden="true">
          <span />
          <span>AI 出题</span>
          <span>网络真题</span>
        </div>
        {MIX_KINDS.map((t) => (
          <div className="quiz-mix-row" key={t}>
            <span className="quiz-mix-label">{MIX_KIND_LABELS[t]}</span>
            <MixStepper
              value={mix[t]}
              cap={mixKindCap(t)}
              totalFull={totalFull}
              disabled={loading || busy}
              onStep={(delta) => bumpAi(t, delta)}
              onSet={(v) => setAi(t, v)}
            />
            {t === 'scenario' ? (
              // 情景题无真题列（契约 §2 约定 1）：列出来只会永远 0，不如明说
              <span className="quiz-mix-na">—（网上摘不到可玩 demo）</span>
            ) : (
              <MixStepper
                value={sourceMix[t]}
                cap={sourceKindCap(t)}
                totalFull={totalFull}
                disabled={loading || busy}
                onStep={(delta) => bumpReal(t, delta)}
                onSet={(v) => setReal(t, v)}
              />
            )}
          </div>
        ))}
      </div>
      <p className="settings-hint">
        上限：AI 单题型 10（情景题 3 套）、真题单题型 5；AI 题 + 真题合并计 {MAX_QUIZ_TOTAL} 道。
      </p>

      <div className="settings-actions">
        <button className="settings-add" disabled={loading || busy || blend === 0 || !dirty} onClick={() => void save()}>
          {busy ? '保存中…' : '保存配比'}
        </button>
        <button
          className="settings-test"
          disabled={loading || busy}
          onClick={() => {
            setMix({ ...DEFAULT_QUIZ_MIX });
            setSourceMix({ ...DEFAULT_QUIZ_SOURCE_MIX });
          }}
        >
          恢复默认
        </button>
        <span className="quiz-mix-total">
          {blend === 0
            ? '共 0 题（至少留 1 题）'
            : `共 ${blend} / ${MAX_QUIZ_TOTAL} 题（其中真题 ${realTotal} 题）${totalFull ? '，已满（先减后加）' : ''}`}
        </span>
      </div>
    </section>
  );
}
