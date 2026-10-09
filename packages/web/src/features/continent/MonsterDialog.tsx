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
 *
 * ★ 横版战斗（2026-09-30，契约 KNOWLEDGE-CONTINENT-SPEC §「横版战斗」）：弹窗变成一块**战场**——
 *   顶上是横版 canvas（`BattleStage`：左勇者、右这只怪、序章同款布景），底下仍是同一套答题。答对 ⇒ 勇者突进、怪掉血；
 *   答错 ⇒ 怪扑过来；吟唱命中 ⇒ 符文；最后一击 ⇒ 怪化沙、`onSolved`。打开时地图先像素化暗下去再亮出战场
 *   （`.continent-battle` 的 CSS 转场，减少动态效果时直接切）。**规则一条没变**：题数 = 血量、答错可重试。
 * ★ 废墟的「复习重建」也走这里（`tile.ruin` 且无怪）：同一场战斗，只是标题说的是"重建"。
 */
import { useMemo, useState } from 'react';
import { BattleStage } from './BattleStage';
import type { BattleEvent, BattleEventKind } from './battle-stage';
import { CONTINENT_QLABEL, buildMonsterQuestions, gradeAnswer, type ContinentAnswer, type SpellKind } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { ContinentQuestionForm, correctText } from './ContinentQuestionForm';
import { cellLabel, tileStatusText, type ContinentTileView } from './continent-view';
import { monsterLook } from './monster-art';
import { SpellBook } from './SpellBook';
import { SpellChant } from './SpellChant';
import type { SpellPlan } from './spell-chant-view';
import './spell-chant.css';
import { AnswerImpact } from '../feedback/AnswerImpact';

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
  /** 当前题的作答（形状即 `gradeAnswer` 入参；控件在 `ContinentQuestionForm`，判分在这里） */
  const [answer, setAnswer] = useState<ContinentAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [spell, setSpell] = useState<SpellState>('idle');
  const [spellPlan, setSpellPlan] = useState<{ plan: SpellPlan; title: string } | null>(null);
  /** 战场事件（序号自增：连答对两题也要各演一遍） */
  const [event, setEvent] = useState<BattleEvent | null>(null);
  const play = (kind: BattleEventKind): void => setEvent((e) => ({ kind, seq: (e?.seq ?? 0) + 1 }));

  const current = questions[qi];
  const answered = current !== undefined && answer !== null && gradeAnswer(current, answer);

  /** 掉 `damage` 滴血 = 往后跳 `damage` 道题；掉光即收复（常规打完不传 `spell`，保持既有调用形状） */
  const hurt = async (damage: number, spell?: SpellKind): Promise<void> => {
    const left = hp - damage;
    if (left > 0) {
      setHp(left);
      setQi(qi + damage);
      setNote(null);
      setAnswer(null);
      play(spell ? 'spell' : 'hit');
      return;
    }
    setHp(0);
    play('defeat');
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
      play('miss');
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

  const rebuild = tile.ruin && !tile.hasMonster;
  return (
    <div className="continent-modal continent-battle" role="dialog" aria-modal="true" aria-label={`${rebuild ? '重建' : '讨伐'} ${tile.term}`}>
      <div className="continent-modal-card continent-battle-card answer-surface">
        {event && <AnswerImpact verdict={event.kind === 'miss' ? 'wrong' : event.kind === 'defeat' ? 'complete' : 'correct'} event={event.seq} />}
        {/* 横版战场：地图 → 战场的转场由 `.continent-battle` 的 CSS 做；血量与下面的血条同源 */}
        <BattleStage tile={tile} hp={hp} maxHp={questions.length} event={event} />
        <header className="continent-modal-head">
          <span className="continent-modal-title">
            {tile.term}
            <small>
              {/* 怪的俗名由怪种（题型序列）定——与图上那张脸、图鉴那一格是同一个名字；来路（野怪/欠账/话题/废墟）由 tileStatusText 说 */}
              {rebuild ? '废墟守卫·' : ''}
              {monsterLook(tile.species).name} · {cellLabel(tile)} · {tileStatusText(tile)}
            </small>
          </span>
          <button className="continent-btn ghost" onClick={onClose}>
            撤退
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

        {current && <ContinentQuestionForm key={qi} q={current} answer={answer} onChange={setAnswer} onEnter={() => void submit()} />}

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
