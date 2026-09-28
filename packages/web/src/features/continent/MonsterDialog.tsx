/**
 * features/continent/MonsterDialog — 打怪答题弹窗（DOM；地图是 canvas，交互一律走 DOM）。
 *
 * ★ 设计取舍②：**Canvas 地图 + DOM 弹窗/图鉴**。弹窗用 DOM 是因为它要能打字/选下拉/被读屏认出，
 *   塞进 canvas 就得手搓一套输入焦点管理——那是把浏览器的活儿抢过来做。
 *
 * ★ 出题走 `shared/continent.ts` 的**本地出题器**（设计取舍①：零 AI/零成本/离线可用），
 *   干扰项从地图上的**全部词条**里取（`pool`）。
 *
 * ★ 规则：
 *   - **题数 = 等级 = 血量**：一型一道，答对掉 1 滴血，掉光即收复。
 *   - **答错不扣分、可重试**：只把正确答案亮出来 ⊂ 这是"复习"不是"考试"，惩罚会把人赶走。
 *   - 全部答对才调 `onSolved` → 父组件走**既有** `terms.mark(id, true)` 推进阶段 ⇒ 怪自然消失。
 *
 * ★ 魔法吟唱（契约 `docs/SPELL-CHANT-SPEC.md`）：每次开怪**一次**机会——翻咒语书选一段历史对话吟唱，
 *   伤害 `damage`（shared 口径）= 掉 `damage` 滴血 = 替你答掉 `damage` 道题（「题数 = 血量」不破）。
 *   血掉光 ⇒ `onSolved(tile, kind)`（这次释放化作的款式）⇒ 父组件放该款的咒语版特效。中断 / 哑火都算用掉，不能翻书试到共鸣为止。
 */
import { useMemo, useState } from 'react';
import {
  CONTINENT_QLABEL,
  buildMonsterQuestions,
  gradeAnswer,
  type ContinentAnswer,
  type ContinentQuestion,
  type SpellKind,
} from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { cellLabel, tileStatusText, type ContinentTileView } from './continent-view';
import { SpellBook } from './SpellBook';
import { SpellChant } from './SpellChant';
import type { SpellPlan } from './spell-chant-view';
import './spell-chant.css';

interface Props {
  tile: ContinentTileView;
  /** 干扰项池（地图上全部词条） */
  pool: readonly ContinentMapTerm[];
  /** 全部答对：父组件负责打卡 + 刷新 + 特效（`spell` 省略即常规答题；给了就是魔法吟唱补刀的款式） */
  onSolved: (tile: ContinentTileView, spell?: SpellKind) => Promise<void> | void;
  onClose: () => void;
}

/** 吟唱状态机：`idle` 可翻书 → `book` 选咒语 → `chant` 吟唱中 → `used` 本次开怪已用掉 */
type SpellState = 'idle' | 'book' | 'chant' | 'used';

/** 正确答案的可读文本（答错时亮出来——比"再想想"有用） */
function correctText(q: ContinentQuestion): string {
  switch (q.type) {
    case 'judge':
      return `正确答案：${q.answer ? '对' : '错'}`;
    case 'choice':
    case 'scene':
      return `正确答案：${q.options[q.answerIndex] ?? ''}`;
    case 'fill':
      return `正确答案：${q.answer}`;
    case 'match':
      return `正确连线：${q.left.map((l, i) => `${l} → ${q.right[q.answer[i] ?? 0] ?? ''}`).join('；')}`;
  }
}

export function MonsterDialog({ tile, pool, onSolved, onClose }: Props) {
  const questions = useMemo(
    () =>
      buildMonsterQuestions(
        { id: tile.id, term: tile.term, definition: tile.definition },
        Math.max(tile.level, 1),
        pool,
      ),
    [tile.id, tile.term, tile.definition, tile.level, pool],
  );
  const [qi, setQi] = useState(0);
  const [hp, setHp] = useState(questions.length);
  const [note, setNote] = useState<string | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [judge, setJudge] = useState<boolean | null>(null);
  const [fillText, setFillText] = useState('');
  const [matchPick, setMatchPick] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [spell, setSpell] = useState<SpellState>('idle');
  const [spellPlan, setSpellPlan] = useState<{ plan: SpellPlan; title: string } | null>(null);

  const current = questions[qi];
  const answered = gradeAnswer(
    current ?? { type: 'fill', prompt: '', answer: '' },
    buildAnswer(current, judge, choice, fillText, matchPick),
  );

  /** 掉 `damage` 滴血 = 往后跳 `damage` 道题；掉光即收复（常规打完不传 `spell`，保持既有调用形状） */
  const hurt = async (damage: number, spell?: SpellKind): Promise<void> => {
    const left = hp - damage;
    if (left > 0) {
      setHp(left);
      setQi(qi + damage);
      setNote(null);
      setJudge(null);
      setChoice(null);
      setFillText('');
      setMatchPick([]);
      return;
    }
    setBusy(true);
    try {
      await (spell ? onSolved(tile, spell) : onSolved(tile));
    } catch (e) {
      setNote(`保存复习记录失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!current || busy) return;
    if (!answered) {
      setNote(`还不对。${correctText(current)}`);
      return;
    }
    await hurt(1);
  };

  /** 吟唱收尾：命中即掉血；哑火 / 中断只留一句话——但都算用掉这次机会 */
  const endSpell = (why: string, cast?: { damage: number; kind: SpellKind }): void => {
    setSpell('used');
    setSpellPlan(null);
    if (cast && cast.damage > 0) void hurt(cast.damage, cast.kind);
    else setNote(why);
  };

  if (spell === 'book') {
    return (
      <SpellBook
        term={tile.term}
        onPick={(plan, session) => {
          setSpellPlan({ plan, title: session.title || '未命名对话' });
          setSpell('chant');
        }}
        onClose={() => setSpell('idle')}
      />
    );
  }
  if (spell === 'chant' && spellPlan) {
    return (
      <SpellChant
        term={tile.term}
        title={spellPlan.title}
        plan={spellPlan.plan}
        onCast={(damage, detail) => endSpell('咒语哑火了——这只怪没掉血，继续答题吧。', { damage, kind: detail.kind })}
        onClose={() => endSpell('吟唱中断——这次开怪的吟唱机会已用掉，剩下的血靠答题。')}
      />
    );
  }

  return (
    <div className="continent-modal" role="dialog" aria-modal="true" aria-label={`复习 ${tile.term}`}>
      <div className="continent-modal-card">
        <header className="continent-modal-head">
          <span className="continent-modal-title">
            {tile.term}
            <small>
              {cellLabel(tile)} · {tileStatusText(tile)}
            </small>
          </span>
          <button className="continent-btn ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        {/* 血条：题数 = 血量（每答对一道掉一滴） */}
        <div className="continent-hp">
          {questions.map((q, i) => (
            <span
              key={`${q.type}-${i}`}
              className={i < hp ? 'continent-hp-dot on' : 'continent-hp-dot'}
              title={CONTINENT_QLABEL[q.type]}
            />
          ))}
          <em>
            第 {Math.min(qi + 1, questions.length)} / {questions.length} 题
          </em>
        </div>

        {current && (
          <div className="continent-q">
            <p className="continent-q-type">{CONTINENT_QLABEL[current.type]}</p>
            {/* 情景题多一层"情境框"（照抄 demo 的 `SCENE_FRAME`）：它把题干放进一个场景里，
                其余作答手势与选择题完全一致——所以下面 options 与 choice 共用一段渲染 */}
            {current.type === 'scene' && <p className="continent-q-frame">{current.frame}</p>}
            <p className="continent-q-prompt">{current.type === 'judge' ? current.statement : current.prompt}</p>

            {current.type === 'judge' && (
              <div className="continent-opts">
                <button className={judge === true ? 'continent-opt on' : 'continent-opt'} onClick={() => setJudge(true)}>
                  对
                </button>
                <button className={judge === false ? 'continent-opt on' : 'continent-opt'} onClick={() => setJudge(false)}>
                  错
                </button>
              </div>
            )}

            {(current.type === 'choice' || current.type === 'scene') && (
              <div className="continent-opts">
                {current.options.map((opt, i) => (
                  <button
                    key={`${i}-${opt}`}
                    className={choice === i ? 'continent-opt on' : 'continent-opt'}
                    onClick={() => setChoice(i)}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}

            {current.type === 'fill' && (
              <input
                className="continent-input"
                value={fillText}
                placeholder="填入词条"
                onChange={(e) => setFillText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                }}
              />
            )}

            {current.type === 'match' && (
              <ul className="continent-match">
                {current.left.map((l, i) => (
                  <li key={`${i}-${l}`}>
                    <span>{l}</span>
                    <select
                      value={matchPick[i] ?? ''}
                      onChange={(e) => {
                        const next = [...matchPick];
                        next[i] = Number(e.target.value);
                        setMatchPick(next);
                      }}
                    >
                      <option value="">选择释义…</option>
                      {current.right.map((r, ri) => (
                        <option key={`${ri}-${r}`} value={ri}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {note && <p className="continent-note">{note}</p>}

        <footer className="continent-modal-foot spell-foot">
          <button
            className="continent-btn ghost"
            disabled={busy || spell === 'used'}
            title={spell === 'used' ? '这次开怪的吟唱机会已用掉' : '翻开咒语书：用一段聊过的对话对它施法'}
            onClick={() => setSpell('book')}
          >
            {spell === 'used' ? '吟唱已用' : '魔法吟唱'}
          </button>
          <button className="continent-btn primary" disabled={busy} onClick={() => void submit()}>
            {hp <= 1 ? '最后一击' : '提交'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 把各题型的本地作答状态拼成判分入参（判分一律走 `gradeAnswer`，组件不自己比） */
function buildAnswer(
  q: ContinentQuestion | undefined,
  judge: boolean | null,
  choice: number | null,
  fillText: string,
  matchPick: number[],
): ContinentAnswer {
  if (!q) return '';
  switch (q.type) {
    case 'judge':
      return judge ?? false;
    case 'choice':
    case 'scene':
      return choice ?? -1;
    case 'fill':
      return fillText;
    case 'match':
      return q.left.map((_, i) => matchPick[i] ?? -1);
  }
}
