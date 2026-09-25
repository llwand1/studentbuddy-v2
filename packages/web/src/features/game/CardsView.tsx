/**
 * CardsView — 卡牌页（三屏合一的壳：宝箱条 / 任务清单 / 卡墙）。
 *
 * ★ 三屏共用**一次** `GET /api/cards/state`（`use-cardsState`），不是三个各自拉数的组件：
 *   它们之间有等式（`summary.totalCards` = 卡墙各行之和、清单的进度来自同一份聚合），
 *   分开取数就会出现"四块来自四个瞬间"而谁也自证不了一致（契约 §7 文件头①，B-007 族）。
 * ★ 顺序照多邻国的信息层级排：**能立刻做的动作在最上面**（开盒、清任务），收藏陈列在下面。
 *   反过来的话首屏是一堵墙，而墙不需要每天看两次。
 * ⚠️ `data === null` 与「读到了但库里空着」是两件事，各画一屏（前者是"没读到"，要给了重试；
 *   后者才是真的空态）——把失败画成空态，用户会以为自己的数据没了。
 */
import { SparkleIcon, MascotIcon, StarIcon, TaskIcon, KeyIcon } from '../../components/game-icons';
import { CardsIcon } from '../../components/icons';
import { useCardsState } from './use-cards-state';
import { CardWall } from './CardWall';
import { TaskListPanel } from './TaskListPanel';
import { ChestPanel } from './ChestPanel';
import '../../styles/game.css';
import './cards-view.css';

/** 顶栏那几颗统计：全部来自 `summary`，这里**不再算一遍**（两处算法必漂） */
function StatsBar({
  totalTerms,
  totalCards,
  ssr,
  almostThere,
  earnedKeys,
}: {
  totalTerms: number;
  totalCards: number;
  ssr: number;
  almostThere: number;
  earnedKeys: number;
}) {
  return (
    <div className="cv-stats">
      <span className="gm-stat">
        <CardsIcon size={15} /> {totalTerms} <small>条词条</small>
      </span>
      <span className="gm-stat">
        <StarIcon size={15} /> {totalCards} <small>张卡</small>
      </span>
      <span className="gm-stat">
        <SparkleIcon size={15} /> {ssr} <small>SSR</small>
      </span>
      <span className="gm-stat">
        <TaskIcon size={15} /> {almostThere} <small>临门一脚</small>
      </span>
      <span className="gm-stat gm-key">
        <KeyIcon size={15} /> {earnedKeys} <small>把钥匙</small>
      </span>
    </div>
  );
}

export function CardsView() {
  const s = useCardsState();

  if (s.data === null) {
    return (
      <section className="cv-page">
        <div className="cv-lede">
          <MascotIcon size={22} />
          {s.error ? (
            <>
              <span>卡牌数据没读到：{s.error}</span>
              <button type="button" className="gm-btn gm-ghost gm-sm" onClick={() => void s.refresh()}>
                重试
              </button>
            </>
          ) : (
            <span>正在清点你的卡牌…</span>
          )}
        </div>
      </section>
    );
  }

  const { summary, wall, logSince, chest, tasks, candidates } = s.data;

  return (
    <section className="cv-page">
      <div className="cv-lede">
        <MascotIcon size={26} />
        <span>
          每一次提及、每一个复习日、每一次收下，都是一张卡。<b>攒够 2 张升 ★1，之后每颗星要翻倍</b>
          （★3 要 8 张、★8 要 256 张）。
        </span>
      </div>

      <StatsBar
        totalTerms={summary.totalTerms}
        totalCards={summary.totalCards}
        ssr={summary.byRarity.SSR}
        almostThere={summary.almostThere}
        earnedKeys={chest.earnedKeys}
      />

      {/* 失败时**不清空已读到的那一版**（旧读数 + 一句"这次没刷新成功"，比整页消失有用） */}
      {s.error && (
        <div className="gm-banner gm-bad" role="alert">
          <SparkleIcon size={20} />
          <div>
            <b>这次没刷新成功</b>
            <span>
              {s.error}
              {s.link === 'polling' ? '（长连接不稳，已降级成每 2 秒轮询）' : ''}
            </span>
          </div>
          <button type="button" className="gm-btn gm-ghost gm-sm" onClick={() => void s.refresh()}>
            重试
          </button>
        </div>
      )}

      <ChestPanel
        chest={chest}
        ready={s.chestReady}
        onOpened={s.clearChestReady}
        onChest={s.patchChest}
        onChanged={() => void s.refresh()}
      />

      <TaskListPanel
        tasks={tasks}
        candidates={candidates}
        freshTaskIds={s.freshTaskIds}
        onChanged={() => void s.refresh()}
      />

      <CardWall rows={wall} logSince={logSince} />
    </section>
  );
}
