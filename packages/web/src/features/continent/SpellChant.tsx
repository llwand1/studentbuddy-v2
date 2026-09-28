/**
 * features/continent/SpellChant — 吟唱框：把选中的历史对话按节重放，复述提问 / 重做题目，最后释放（契约 §3.3–3.4）。
 *
 * ★ 组件**不算口径**：像不像（`resonates` / `promptSimilarity` / `resonanceThreshold`）、遮多少（`maskPrompt`）、
 *   打多少（`chantPower` / `spellDamage`）全在 `shared/spell-chant.ts`；题目判分在 `SpellQuizVerse`（复用对话页判分）。
 * ★ 四个阶段：`chant`（逐节）→ `ready`（全部节完成，等一下「释放」）→ `cast`（释放动画）→ `done`（结算，回到战斗）。
 * ★ 动效纪律：法阵 / 光环全是 transform + opacity，`prefers-reduced-motion` 下跳过 `cast` 阶段直接结算。
 * ★ 跳过 = 失谐、答错 = 失谐；哑火（0 伤害）也如实结算并交给父组件——不静默、不白送。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  chantPower,
  maskPrompt,
  promptSimilarity,
  resonanceThreshold,
  resonates,
  normText,
  spellDamage,
  type ChantVerse,
  type ChantVerseResult,
} from '@sb/shared';
import { castText, truncatedText, verseTitle, type SpellPlan } from './spell-chant-view';
import { SpellQuizVerse } from './SpellQuizVerse';

/** 释放动画时长（与 canvas 侧 `BURST_MS` 同量级；减少动态效果时为 0） */
export const SPELL_CAST_MS = 1100;

export interface SpellCastDetail {
  power: number;
  total: number;
  resonant: boolean;
}

interface Props {
  /** 目标怪（词条名） */
  term: string;
  /** 咒语名（会话标题） */
  title: string;
  plan: SpellPlan;
  /** 释放完成：`damage` 已按 shared 口径算好（可能为 0 = 哑火） */
  onCast: (damage: number, detail: SpellCastDetail) => void;
  /** 中断吟唱（本次开怪的机会已用掉，父组件负责说明） */
  onClose: () => void;
}

type Phase = 'chant' | 'ready' | 'cast' | 'done';

function calmMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function SpellChant({ term, title, plan, onCast, onClose }: Props) {
  const { verses, truncated, resonant } = plan;
  const [results, setResults] = useState<ChantVerseResult[]>([]);
  const [phase, setPhase] = useState<Phase>(verses.length ? 'chant' : 'ready');

  const vi = results.length;
  const current: ChantVerse | undefined = verses[vi];
  const power = chantPower(results);
  const damage = spellDamage(power, resonant);

  const advance = (r: ChantVerseResult): void => {
    if (phase !== 'chant') return;
    const next = [...results, r];
    setResults(next);
    if (next.length >= verses.length) setPhase('ready');
  };

  const cast = (): void => {
    if (phase !== 'ready') return;
    setPhase(calmMotion() ? 'done' : 'cast');
  };

  useEffect(() => {
    if (phase !== 'cast') return;
    const id = window.setTimeout(() => setPhase('done'), SPELL_CAST_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  const casting = phase === 'cast';
  const detail: SpellCastDetail = { power, total: verses.length, resonant };

  return (
    <div className={casting ? 'continent-modal spell-modal casting' : 'continent-modal spell-modal'} role="dialog" aria-modal="true" aria-label={`吟唱 ${title}`}>
      <div className={`continent-modal-card spell-card spell-chant phase-${phase}${resonant ? ' resonant' : ''}`}>
        <i className="spell-circle" aria-hidden="true" />
        <i className="spell-circle inner" aria-hidden="true" />

        <header className="continent-modal-head">
          <span className="continent-modal-title">
            魔法吟唱
            <small>
              咒语「{title}」→ {term}
              {resonant && <b className="spell-tag">共鸣 ×2</b>}
            </small>
          </span>
          {phase !== 'cast' && phase !== 'done' && (
            <button className="continent-btn ghost" onClick={onClose}>
              中断
            </button>
          )}
        </header>

        <ol className="spell-runes" aria-label="吟唱进度">
          {verses.map((v, i) => {
            const r = results[i];
            const cls = r === 'hit' ? 'hit' : r === 'miss' ? 'miss' : i === vi && phase === 'chant' ? 'now' : 'todo';
            return <li key={i} className={`spell-rune ${cls}`} title={verseTitle(v, i)} aria-label={`${verseTitle(v, i)}：${r === 'hit' ? '命中' : r === 'miss' ? '失谐' : '未吟'}`} />;
          })}
          <em>
            {phase === 'chant' ? `第 ${Math.min(vi + 1, verses.length)} / ${verses.length} 节` : `${verses.length} 节 · 命中 ${power}`}
          </em>
        </ol>
        {truncatedText(truncated) && phase === 'chant' && vi === 0 && <p className="spell-dim">{truncatedText(truncated)}</p>}

        {phase === 'chant' && current && (
          <section className="spell-verse" key={vi} aria-live="polite">
            <p className="continent-q-type">{verseTitle(current, vi)}</p>
            {current.kind === 'recall' ? (
              <RecallVerse prompt={current.prompt} echo={current.echo} seed={`${title}|${vi}`} onResult={(hit) => advance(hit ? 'hit' : 'miss')} />
            ) : (
              <SpellQuizVerse question={current.question} title={current.title} onResult={(hit) => advance(hit ? 'hit' : 'miss')} />
            )}
          </section>
        )}

        {phase === 'ready' && (
          <section className="spell-verse spell-ready">
            <p className="continent-q-prompt">
              {power > 0 ? `咒语已成：${verses.length} 节里命中 ${power} 节${resonant ? '，且与这块地共鸣' : ''}。` : '咒语没有一节共鸣——释放出去也只会哑火。'}
            </p>
            <footer className="continent-modal-foot">
              <button className="continent-btn primary spell-cast-btn" onClick={cast}>
                {power > 0 ? `释放咒语（${damage} 点）` : '释放（哑火）'}
              </button>
            </footer>
          </section>
        )}

        {casting && (
          <div className="spell-cast-fx" aria-hidden="true">
            <i className="spell-ring r1" />
            <i className="spell-ring r2" />
            <i className="spell-ring r3" />
            <i className="spell-flash" />
            <b className="spell-cast-num">{damage}</b>
          </div>
        )}

        {phase === 'done' && (
          <section className="spell-verse spell-done" role="status">
            <p className="continent-q-prompt">{castText(damage, power, verses.length, resonant)}</p>
            <footer className="continent-modal-foot">
              <button className="continent-btn primary" onClick={() => onCast(damage, detail)}>
                回到战斗
              </button>
            </footer>
          </section>
        )}
      </div>
    </div>
  );
}

interface RecallProps {
  prompt: string;
  echo: string;
  seed: string;
  onResult: (hit: boolean) => void;
}

/** 「复述当初的提问」一节：看回响 + 遮罩，把当初的话再说一遍；共鸣条实时显示相似度与阈值 */
function RecallVerse({ prompt, echo, seed, onResult }: RecallProps) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const masked = useMemo(() => maskPrompt(prompt, seed), [prompt, seed]);
  const sim = promptSimilarity(prompt, text);
  const need = resonanceThreshold([...normText(prompt)].length);
  const ok = resonates(prompt, text);
  const pct = Math.round(sim * 100);
  const needPct = Math.round(need * 100);

  const tryHit = (): void => {
    if (!ok) {
      setNote(text.trim() ? '还差一点——不用逐字，把当初问的意思说全就行。' : '先把当初的提问再说一遍。');
      return;
    }
    onResult(true);
  };

  return (
    <div className="continent-q spell-recall">
      <p className="spell-echo-label">回响（当初 AI 回答的开头）</p>
      <blockquote className="spell-echo">{echo || '这一轮没有留下回响——当初的回答被中断了。'}</blockquote>
      <p className="spell-echo-label">当初的提问（遮罩）</p>
      <p className="spell-mask" aria-label="遮罩后的原提问">
        {masked}
      </p>
      <input
        className="continent-input spell-input"
        value={text}
        placeholder="把当初的提问再说一遍…"
        aria-label="复述提问"
        onChange={(e) => {
          setText(e.target.value);
          setNote(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') tryHit();
        }}
      />
      <div className={ok ? 'spell-meter ok' : 'spell-meter'} role="progressbar" aria-label="共鸣度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i className="spell-meter-fill" style={{ width: `${Math.min(100, pct)}%` }} /> {/* gates:style-ok 宽度随相似度实时变，无法枚举成 class */}
        <em>
          共鸣 {pct}% · 需 {needPct}%
        </em>
      </div>
      {note && <p className="continent-note">{note}</p>}
      <footer className="continent-modal-foot">
        <button className="continent-btn ghost" onClick={() => onResult(false)}>
          跳过这一节
        </button>
        <button className="continent-btn primary" disabled={!ok} onClick={tryHit}>
          吟诵
        </button>
      </footer>
    </div>
  );
}
