/**
 * features/continent/ContinentChest — 地图宝箱（= 「每日宝箱」的**第二个入口**）。
 *
 * ★★ 老板裁定（2026-09-26）：「复用现有账本，地图当第二个入口」。四句约束落地在这里：
 *   ① **零新表、零新写口**：开箱与收卡都走既有 `cardsApi.openChest` / `acceptDraw`
 *      （`POST /api/cards/chest/open`、`/chest/accept`），本文件**没有**任何新端点；
 *   ② **零新随机**：稀有度/星位一律由 `RitualOverlay` 内部向 `@sb/shared` 的 `rarityOf`/`starOf`
 *      取（按卡数分档），地图侧不自己掷一个"地图专属稀有度"；
 *   ③ 地图上的宝箱**只是位置**（`ContinentChestDrop`），点开消耗的是**当日免费次数/赚来的钥匙**
 *      —— 与卡牌页那次开盒是同一本账，所以两个入口不可能各算一套；
 *   ④ 因此本组件**必须**如实转述服务端的钥匙账（`chest.left.reason` 的三种拦法各有各的话），
 *      不许把"今天开满了"说成"钥匙用完了"（那是两件事，用户据此决定明天来不来）。
 *
 * ★ 为什么复用 `RitualOverlay` 而不是自己画一套开盒动画：开盒的仪式感（T3 档、光束 + 翻卡 +
 *   像素养份）已经被 `TERM-CARDS-SPEC.md` §8 定死，且它的两处"刻意的代价"（拒收也烧钥匙、
 *   收下给两枚钮）是写在 `ChestPanel.tsx` 文件头里的口径。复制一份 = 两处口径开始漂移，
 *   而漂移的形态是「地图上开盒的规则和卡牌页不一样」——用户会当场发现。
 */
import { useCallback, useEffect, useState } from 'react';
import { DAILY_OPEN_CAP, FREE_OPENS_PER_DAY } from '@sb/shared';
import { asChestOpenFailure, cardsApi, type ChestDraw, type ChestState } from '../../lib/api-cards';
import { RitualOverlay } from '../game/ChestPanel';
import type { ContinentChestDrop } from './ContinentMap';

interface Props {
  drop: ContinentChestDrop;
  onClose: () => void;
  /** 这一箱已经开了 ⇒ 父组件把地图上的标记摘掉（掉落物是一次性的） */
  onConsumed: () => void;
  /** 收下可能**往库里写一条新词条** ⇒ 让地图重取一次（否则新词条不长在地图上） */
  onLibraryChanged: () => void;
}

export function ContinentChest({ drop, onClose, onConsumed, onLibraryChanged }: Props) {
  const [chest, setChest] = useState<ChestState | null>(null);
  const [draw, setDraw] = useState<ChestDraw | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // 只读一次钥匙账（零写：跨日归零发生在读侧）。★ 不订阅 SSE——地图不是卡牌面板，
  // 这里只需要"点开这一箱时账目是对的"，那一读就够了（同 `use-cards-state.ts` 头注的取舍精神）。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const s = await cardsApi.state();
        if (alive) setChest(s.chest);
      } catch (e) {
        if (alive) setNote(e instanceof Error ? e.message : '没读到今天的钥匙账');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const open = useCallback(async () => {
    setBusy(true);
    setNote('');
    try {
      const r = await cardsApi.openChest();
      setChest(r.state);
      setDraw(r.draw);
      // ★ 开盖即摘标记：这一箱的"存在"已经兑现成一张卡了（收下/拒收是那张卡的事，`ChestPanel` 管）
      onConsumed();
    } catch (e) {
      const fail = asChestOpenFailure(e);
      if (fail) {
        setChest(fail.chest);
        setNote(fail.error);
      } else {
        setNote(e instanceof Error ? e.message : '开盒请求没走通');
      }
    } finally {
      setBusy(false);
    }
  }, [onConsumed]);

  const accept = async (review: boolean): Promise<void> => {
    if (!draw) return;
    setBusy(true);
    try {
      await cardsApi.acceptDraw(draw.openId, review);
      setDraw(null);
      onLibraryChanged();
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : '收下没落库，请刷新重试');
    } finally {
      setBusy(false);
    }
  };

  const refuse = (): void => {
    // 与 `ChestPanel` 同一句话：拒收也烧钥匙，且这条词不再进池——不许把这设计说成贴心
    setNote('这次开盒的钥匙已经花掉了。想反悔，去「卡牌」页那颗「收下上次那张」还开着——但这条词不会再被抽到第二次。');
    setDraw(null);
    onClose();
  };

  const left = chest?.left ?? null;
  const blocked = left !== null && left.left <= 0;
  const blockedText =
    left?.reason === 'capped' ? `今天已经开满 ${DAILY_OPEN_CAP} 次了，明天再来。` : null;

  return (
    <div className="continent-modal" role="dialog" aria-modal="true" aria-label="地图上的宝箱">
      <div className="continent-modal-card continent-chest-card">
        <header className="continent-modal-head">
          <span className="continent-modal-title">
            宝箱
            <small>打掉「{drop.term}」留下的 · 开的是今天那一本钥匙账</small>
          </span>
          <button className="continent-btn ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        {chest ? (
          <p className="continent-hint-line">
            今天免费 {chest.freeLeft}／{FREE_OPENS_PER_DAY} 次，赚来的钥匙 {chest.earnedKeys} 把（囤着不清零），
            今天已开 {chest.openedToday}／{DAILY_OPEN_CAP} 次。词池里还有 <b>{chest.poolLeft}</b> 条你没见过的新词。
          </p>
        ) : (
          <p className="continent-hint-line">正在读今天的钥匙账…</p>
        )}
        {blockedText && <p className="continent-hint-line">{blockedText}</p>}
        {note && <p className="continent-note">{note}</p>}

        <footer className="continent-modal-foot">
          <button
            type="button"
            className="continent-btn primary"
            disabled={busy || blocked || chest === null}
            onClick={() => void open()}
          >
            {blocked ? (left?.reason === 'capped' ? '今天开满了' : '钥匙用完了') : busy ? '开盒中…' : '开一次'}
          </button>
        </footer>
      </div>

      {draw && (
        <RitualOverlay draw={draw} busy={busy} onAccept={(review) => void accept(review)} onRefuse={refuse} />
      )}
    </div>
  );
}