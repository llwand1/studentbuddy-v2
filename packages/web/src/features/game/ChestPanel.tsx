/**
 * ChestPanel — 每日宝箱：页内状态条 + **独立整屏开盒面板**（T3，契约 §6／§8）。
 *
 * ★ 老板 2026-09-25 的两句原话在这里是两条约束，不是一种氛围：
 *   「抽到的要是新词」⇒ 词池去重全在服务端（`chest.ts:drawablePool` 三段去重），
 *     面板**不解释规则、也不替用户判断**，只如实转述服务端给的 `poolLeft`（0 就说 0）；
 *   「抽到的动画要单独开一个面板动画」⇒ 开盒结果走 `position: fixed` 的整屏遮罩，
 *     不是行内展开、也不是底部 toast。仪式要有自己的地盘，这是"每日的事"的分量来源。
 *
 * ★★ 面板必须说实话的两处（都是**刻意的代价**，写在 `chest.ts` 文件头）：
 *   ① 「先不要」也要烧一把钥匙，而且这条词**不会再出现**——不烧就能"不满意就重抽"刷到满意，
 *      抽卡的稀缺感当场归零。UI 不能把这设计伪装成贴心，所以拒收时把这句写在明面上。
 *   ② 收下给**两枚钮**（收下／收下并纳入复习），不替用户默认勾选：v28 起新词条默认不在复习
 *      范围，而"不在池子里却显示催你复习"是假的（`TermsPage.tsx` 那条注释）。
 *
 * ⚠️ 刷新后待处理那张仍在（`chestState.pending`）：开盒是**已经发生**的事件，不能因为换页面
 *   就消失。所以状态条在 `pending` 非空时把入口文案改成「上次那张还没收下」。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type ChestDraw, type ChestState } from '../../lib/api';
import { asChestOpenFailure } from '../../lib/api-cards';
import { DAILY_OPEN_CAP, FREE_OPENS_PER_DAY, rarityOf, starOf } from '@sb/shared';
import { ChestIcon, KeyIcon, LockIcon } from '../../components/game-icons';
import '../../styles/game.css';
import './cards-view.css';

/** 开盖 → 翻卡的分镜：光束 700ms、翻卡 620ms，取"光起大半再翻"这一档 */
const REVEAL_MS = 520;

/** 亮卡那一刻的像素养份颗数：与 `game.css` 的 `.gm-confetti > i:nth-child(1..16)` 一一对应，
 *  ★ **两处必须同改**（同 `CardWall.tsx` 的 `SPARKS` 那条耦合，锁见 `card-motion.test.ts`）。
 *  16 是上限而不是起点——它们只在 T3 这一屏同时存在，且**放一次就不播**（不是循环），
 *  所以这条屏的合成层峰值是 16，不是"墙上每张卡各来一条"。 */
const CONFETTI = 16;

/**
 * 收下之后这张卡的**真实**读数：1 张建卡 + 1 张宝箱收下 = 2 张 ⇒ ★1、R 档
 * （口径见 `server/learning/term-cards.ts` 文件头那句"从宝箱收下的词条天生 ★1"）。
 * ★ 星与档一律向 `@sb/shared` 的纯函数要，**不在这里手写数字**：手写一份就是
 *   「开箱面板说 ★2、卡墙是 ★1」的开端（`doc-rag.ts` 常量双写同族病）。
 */
const ACCEPTED_CARDS = 2;

type Phase = 'lid' | 'reveal';

/**
 * 开盒仪式（整屏遮罩 + 光束 + 翻卡 + 像素养份）。
 * ★ **导出**是给知识大陆的地图宝箱用的（`features/continent/ContinentChest.tsx`）：那是同一个
 *   每日宝箱账本的**第二个入口**，仪式必须同一份——自己再画一套，两边的规则就会开始漂移，
 *   而漂移的形态是「地图上开盒和卡牌页不一样」，用户会当场发现。本组件不含任何请求逻辑，
 *   所以复用它是纯展示层的复用（写口仍在各自调用方的 `api.cards.*`）。
 */
export function RitualOverlay({
  draw,
  busy,
  onAccept,
  onRefuse,
}: {
  draw: ChestDraw;
  busy: boolean;
  onAccept: (review: boolean) => void;
  onRefuse: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('lid');
  useEffect(() => {
    const t = setTimeout(() => setPhase('reveal'), REVEAL_MS);
    return () => clearTimeout(t);
  }, [draw.openId]);

  const star = starOf(ACCEPTED_CARDS);
  const rarity = rarityOf(ACCEPTED_CARDS);

  return (
    <div className="gm-ov" role="dialog" aria-modal="true" aria-label="开宝箱">
      <div className="gm-ritual">
        <i className="gm-rays" aria-hidden="true" />
        {phase === 'lid' && <i className="gm-beam" aria-hidden="true" />}
        {phase === 'lid' ? (
          <div className="gm-flip">
            <div className="gm-flip-in gm-face">
              <ChestIcon size={48} />
              <b>开盖中</b>
              <span>先别眨眼</span>
            </div>
          </div>
        ) : (
          <div className="gm-flip" data-r={rarity}>
            <div className="gm-flip-in gm-face">
              <span className="gm-eyebrow">{draw.domain}</span>
              <b>{draw.term}</b>
              <span>{draw.definition}</span>
              <span className="gm-stars" aria-label={`收下后 ${star} 星`}>
                {Array.from({ length: star }, (_, i) => (
                  <i key={i} className="on" />
                ))}
              </span>
            </div>
          </div>
        )}

        {phase === 'reveal' && (
          <span className="gm-confetti" aria-hidden="true">
            {Array.from({ length: CONFETTI }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        )}

        {phase === 'reveal' && (
          <>
            <p className="cv-chest-why">
              {draw.cost === 'earned'
                ? '这次花的是赚来的钥匙（完成一单 +1 把）。'
                : draw.cost === 'free'
                  ? '这次花的是今天的免费次数。'
                  : '这张是你上次抽到、还没收下的——那次开盒的钥匙已经花掉了。'}
            </p>
            <div className="gm-ritual-actions">
              <button type="button" className="gm-btn gm-ok" disabled={busy} onClick={() => onAccept(true)}>
                收下并纳入复习
              </button>
              <button type="button" className="gm-btn" disabled={busy} onClick={() => onAccept(false)}>
                只收下
              </button>
            </div>
            <button type="button" className="gm-btn gm-ghost gm-block" disabled={busy} onClick={onRefuse}>
              先不要
            </button>
            <p className="cv-chest-why">
              收下就是 ★1 起步（建卡那张 + 宝箱这张）。而「先不要」也<b>已经烧掉这一把钥匙</b>，这条词也不会再被抽到第二次——不满意不能重抽刷到满意为止。
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export function ChestPanel({
  chest,
  onChest,
  onChanged,
  ready,
  onOpened,
}: {
  chest: ChestState;
  onChest: (next: ChestState) => void;
  onChanged: () => void;
  /** `chest_ready` 推来的一帧：让按钮上的呼吸灯亮起来，点开面板即清 */
  ready: boolean;
  onOpened: () => void;
}) {
  const [draw, setDraw] = useState<ChestDraw | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const open = useCallback(async () => {
    setBusy(true);
    setNote('');
    try {
      const r = await api.cards.openChest();
      onChest(r.state);
      setDraw(r.draw);
      onOpened();
    } catch (e) {
      const fail = asChestOpenFailure(e);
      if (fail) {
        // ★ 失败体里带着**当下的钥匙账**：按钮的禁用态与文案都要靠它，省一次全量读
        onChest(fail.chest);
        setNote(fail.error);
      } else {
        setNote(e instanceof Error ? e.message : '开盒请求没走通');
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [onChest, onOpened, onChanged]);

  const accept = async (review: boolean) => {
    if (!draw) return;
    setBusy(true);
    try {
      await api.cards.acceptDraw(draw.openId, review);
      setDraw(null);
      setNote(review ? `「${draw.term}」已收下，并进了复习范围。` : `「${draw.term}」收下了，没进复习范围（可在词条页逐条纳入）。`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : '收下没落库，请刷新重试');
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const refuse = () => {
    // ★ 拒收不等于"这行没了"：`chestState.pending` 下一次读仍会把它带回来，所以文案不许说死。
    //   说"就当没要"而入口又出现，用户读到的是界面在骗他——如实写成"还能反悔，但这条词不再进池"。
    setNote(`这次开盒的钥匙已经花掉了。想反悔，右边那颗「收下上次那张」还开着——但这条词不会再被抽到第二次。`);
    setDraw(null);
    onChanged();
  };

  const blocked = chest.left.left <= 0;
  const pendingAgain = !draw && chest.pending !== null;

  return (
    <>
      <div className="cv-chest">
        <div className="cv-chest-lead">
          <div className="cv-chest-title">
            <ChestIcon size={24} />
            每日宝箱
            {ready && !blocked && <i className="cv-live cv-chest-pulse" aria-hidden="true" />}
          </div>
          {/* 三个数各管一件事，混说会误导：免费次数按本地日历日归零、钥匙跨日囤着、
              当日开盒总数还有一道硬上限（`chest.ts` 文件头 2.）。常数向 shared 要，不手写 3/8。 */}
          <p className="cv-chest-why">
            今天免费 {chest.freeLeft}／{FREE_OPENS_PER_DAY} 次，赚来的钥匙 {chest.earnedKeys} 把（囤着不清零），今天已开 {chest.openedToday}／{DAILY_OPEN_CAP} 次。词池里还有 <b>{chest.poolLeft}</b> 条你没见过的新词。
          </p>
          {note && <p className="cv-chest-why">{note}</p>}
        </div>
        <div className="cv-chest-actions">
          <span className="gm-stat gm-key">
            <KeyIcon size={16} /> {chest.earnedKeys}
          </span>
          {pendingAgain ? (
            <button type="button" className="gm-btn gm-warn" onClick={() => setDraw(chest.pending)}>
              收下上次那张
            </button>
          ) : (
            <button type="button" className="gm-btn" disabled={busy || blocked} onClick={() => void open()}>
              {blocked ? <LockIcon size={16} /> : <KeyIcon size={16} />}
              {blocked
                ? chest.left.reason === 'capped'
                  ? '今天开满了'
                  : '钥匙用完了'
                : busy
                  ? '开盒中…'
                  : '开一次'}
            </button>
          )}
        </div>
      </div>

      {draw && (
        <RitualOverlay draw={draw} busy={busy} onAccept={(review) => void accept(review)} onRefuse={refuse} />
      )}
    </>
  );
}
