/**
 * features/continent/ContinentPage — 知识大陆独立页（侧栏一级入口）。
 *
 * 页面只做四件事：**取数 → 派生视图 → 画地图 → 派发交互**。口径全在别处：
 *   取数 `api.terms.map()`（只读端点）、派生 `continent-view.ts`、出题/判分 `shared/continent.ts`、
 *   走位 `useContinentHero.ts`、绘制 `continent-canvas.ts`、答题 `MonsterDialog.tsx`、
 *   图鉴 `CodexPanel.tsx`、宝箱 `ContinentChest.tsx`。
 *
 * ★ **只新增一个写口，而且是既有端点**：解锁/收复一律走 `api.terms.mark(id, true)`。
 *   答对 ⇒ 阶段推进 ⇒ 状态离开 due/overdue ⇒ 怪消失、领地回归（SPEC §4.2 零新表零迁移）。
 *   宝箱也不是新写口：`ContinentChest` 调的是 `POST /api/cards/chest/open`（既有每日宝箱账本）。
 * ★ 打卡失败**不吞**：`mark` 对范围外词条会 409，虽然地图已按服务端结论不画这类怪，
 *   但真出现（数据刚好在两次请求间被改）也要把话念出来，而不是"点了没反应"。
 * ★ **点地走位**与**打怪**共用一次点击：够得着就开打，够不着就先走过去（老板点单的"靠近才开打"）。
 *   走位是被挡也要说话的（`useContinentHero.blocked` → 地图提示行），不许静默。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { ContinentChest } from './ContinentChest';
import { ContinentMap, type ContinentChestDrop } from './ContinentMap';
import { MonsterDialog } from './MonsterDialog';
import { CodexPanel } from './CodexPanel';
import { buildContinentView, canStrike, tileStatusText, type ContinentTileView } from './continent-view';
import { useContinentHero } from './useContinentHero';
import './continent.css';

export function ContinentPage() {
  const [terms, setTerms] = useState<ContinentMapTerm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 打怪弹窗（有怪的地块，或"点领地 → 打领主"） */
  const [hunting, setHunting] = useState<ContinentTileView | null>(null);
  /** 普通地块的详情卡（已收复 / 范围外） */
  const [detail, setDetail] = useState<ContinentTileView | null>(null);
  const [showCodex, setShowCodex] = useState(false);
  const [burst, setBurst] = useState<ContinentTileView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 地上掉落的宝箱（本局打怪留下的位置；**不落库**——开箱走既有账本） */
  const [drops, setDrops] = useState<ContinentChestDrop[]>([]);
  const [chestAt, setChestAt] = useState<ContinentChestDrop | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.terms.map();
      setTerms(r.terms);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 派生**两次**，这一次先后是刻意的：
   * ① 不带英雄 —— 走位 hook 需要 `tiles` 才知道英雄能站哪，而英雄位置又是领地扩散的输入；
   * ② 带英雄 —— 怪不吞英雄脚下那格（`spreadLands` 的 `blocked`），于是"站在哪"看得见后果。
   * ★ 收敛性：英雄起点取自 ① 里第一格可通行的地块；它在 ② 里正好被记为"英雄格"而不会被占，
   *   所以起点稳定、不会两次派生来回抖（这条不稳就会表现为"英雄每帧都在跳"）。
   */
  const baseView = useMemo(() => buildContinentView(terms ?? []), [terms]);
  const heroCtl = useContinentHero(baseView.tiles);
  const view = useMemo(() => buildContinentView(terms ?? [], { hero: heroCtl.hero }), [terms, heroCtl.hero]);

  /** 全部答对：打卡 → 关弹窗 → 播特效 → 地上留一箱 → 重取地图（怪随之消失、领地回归） */
  const solve = useCallback(
    async (tile: ContinentTileView) => {
      try {
        await api.terms.mark(tile.id, true);
        setHunting(null);
        setBurst({ ...tile });
        setDrops((d) =>
          d.some((x) => x.row === tile.row && x.col === tile.col) ? d : [...d, { row: tile.row, col: tile.col, term: tile.term }],
        );
        setNotice(`收复了「${tile.term}」——复习阶段推进，这块地回到你手里，地上留下一个宝箱。`);
        await load();
      } catch (e) {
        setNotice(`${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [load],
  );

  /** 点击分流：宝箱 → 打怪（够得着才开打）→ 领地（打领主）→ 空地（走过去 + 看详情） */
  const pick = useCallback(
    (row: number, col: number) => {
      setNotice(null);
      const drop = drops.find((d) => d.row === row && d.col === col);
      if (drop) {
        setChestAt(drop);
        return;
      }
      const tile = view.tiles.find((t) => t.row === row && t.col === col);
      if (tile?.hasMonster) {
        if (canStrike(heroCtl.hero, tile)) {
          setHunting(tile);
          return;
        }
        heroCtl.walkTo(row, col);
        setNotice(`先走到「${tile.term}」旁边再点它开打——隔空打怪不算复习。`);
        return;
      }
      // ★ 领地格上站着的不是怪，是**领主的地**：点它就打领主（照抄 demo 的 `review_unlock`：不要求相邻）
      //   领地可能压在词条格上（`tile.isLand`），也可能落在没铺词条的荒地上（查不到 tile）
      const ownerId = tile?.isLand ? tile.landOwner : view.wildLands.find((l) => l.row === row && l.col === col)?.owner;
      if (ownerId) {
        const owner = view.tiles.find((t) => t.id === ownerId);
        if (owner) {
          setHunting(owner);
          setNotice(`这是「${owner.term}」的领地——答对它，这片地就回来了。`);
        }
        return;
      }
      if (tile) {
        heroCtl.walkTo(row, col);
        setDetail(tile);
      }
    },
    [drops, heroCtl, view],
  );

  /** 键盘走位（方向键 / WASD）。弹窗开着时让位——不然打字会变成走路 */
  const stepHero = heroCtl.step;
  const frozen = hunting !== null || chestAt !== null;
  useEffect(() => {
    if (frozen) return;
    const dirs: Record<string, [number, number]> = {
      arrowup: [-1, 0],
      arrowdown: [1, 0],
      arrowleft: [0, -1],
      arrowright: [0, 1],
      w: [-1, 0],
      s: [1, 0],
      a: [0, -1],
      d: [0, 1],
    };
    const onKey = (e: KeyboardEvent): void => {
      const dir = dirs[e.key.toLowerCase()];
      if (!dir) return;
      e.preventDefault();
      stepHero(dir[0], dir[1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frozen, stepHero]);

  return (
    <div className="continent-page">
      <header className="continent-head">
        <h1>
          知识大陆
          <small>
            词条从中心长出来；逾期未复习的会被怪占领并向外扩地——走过它们旁边开打，答对就把地收回来
          </small>
        </h1>
        <div className="continent-stats">
          <span>
            词条 <b>{view.total}</b>
          </span>
          <span>
            已纳入复习 <b>{view.inScopeCount}</b>
          </span>
          <span className={view.monsterCount > 0 ? 'continent-stat-warn' : ''}>
            待收复的怪 <b>{view.monsterCount}</b>
          </span>
          <span className={view.landCount > 0 ? 'continent-stat-warn' : ''}>
            被占领的地 <b>{view.landCount}</b>
          </span>
          <span>
            图鉴 <b>{view.codexFound.size}</b>/{view.codexTotal}
          </span>
          <button className="continent-btn" onClick={() => setShowCodex((v) => !v)}>
            {showCodex ? '收起图鉴' : '看图鉴'}
          </button>
          <button className="continent-btn ghost" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </header>

      {notice && <p className="continent-banner">{notice}</p>}
      {view.dueOutOfScope > 0 && (
        <p className="continent-banner dim">
          还有 {view.dueOutOfScope} 条到期词条没纳入复习范围，它们只铺地、不冒怪——
          在「词条」页把它们或所属领域勾进复习范围后，这里就会冒出来。
        </p>
      )}
      {view.truncated > 0 && (
        <p className="continent-banner dim">地图满 140 格，另有 {view.truncated} 条词条暂未铺上图。</p>
      )}
      {drops.length > 0 && (
        <p className="continent-banner dim">
          地上有 {drops.length} 个宝箱（打怪留下的）——点地图上的宝箱就能开，花的是「每日宝箱」那本钥匙账。
        </p>
      )}

      {error && <p className="continent-banner warn">地图加载失败：{error}</p>}
      {terms === null && !error && <p className="continent-banner dim">正在展开大陆…</p>}
      {terms !== null && view.total === 0 && (
        <p className="continent-banner dim">
          大陆还是一片空地。先去「词条」页添加，或在对话里存几条词条——它们会从中心长出来。
        </p>
      )}

      <div className={showCodex ? 'continent-body with-codex' : 'continent-body'}>
        <ContinentMap
          tiles={view.tiles}
          wildLands={view.wildLands}
          hero={heroCtl.hero}
          heroFrom={heroCtl.animFrom}
          heroStart={heroCtl.animStart}
          chests={drops}
          onPick={pick}
          burst={burst}
          focus={hunting ?? detail}
          alert={heroCtl.blocked}
        />
        {showCodex && <CodexPanel found={view.codexFound} onClose={() => setShowCodex(false)} />}
      </div>

      {/* D-pad：键盘之外的走位入口（触屏/鼠标玩家不该为了走一步去挂键盘） */}
      <div className="continent-dpad" aria-label="走位">
        <button className="continent-btn ghost" onClick={() => heroCtl.step(-1, 0)} aria-label="向上走">
          ▲
        </button>
        <button className="continent-btn ghost" onClick={() => heroCtl.step(0, -1)} aria-label="向左走">
          ◀
        </button>
        <button className="continent-btn ghost" onClick={heroCtl.halt} aria-label="停下">
          停
        </button>
        <button className="continent-btn ghost" onClick={() => heroCtl.step(0, 1)} aria-label="向右走">
          ▶
        </button>
        <button className="continent-btn ghost" onClick={() => heroCtl.step(1, 0)} aria-label="向下走">
          ▼
        </button>
        {heroCtl.queued > 0 && <span className="continent-dpad-queue">还要走 {heroCtl.queued} 步</span>}
      </div>

      {hunting && (
        <MonsterDialog tile={hunting} pool={terms ?? []} onSolved={solve} onClose={() => setHunting(null)} />
      )}

      {detail && (
        <div className="continent-detail">
          <span className="continent-modal-title">
            {detail.term}
            <small>
              {detail.domain} · {tileStatusText(detail)}
            </small>
          </span>
          <p className="continent-detail-def">{detail.definition}</p>
          <button className="continent-btn ghost" onClick={() => setDetail(null)}>
            关闭
          </button>
        </div>
      )}

      {chestAt && (
        <ContinentChest
          drop={chestAt}
          onClose={() => setChestAt(null)}
          onConsumed={() => setDrops((d) => d.filter((x) => x !== chestAt))}
          onLibraryChanged={() => void load()}
        />
      )}
    </div>
  );
}