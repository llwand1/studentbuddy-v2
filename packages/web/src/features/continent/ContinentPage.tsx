/**
 * features/continent/ContinentPage — 知识大陆独立页（侧栏一级入口）。
 *
 * 2026-09-28 起是**开拓制**：大陆从出生点一格开始，玩家站到迷雾边上点它开拓（花开拓令），
 * 打败迷雾边上的野怪一次开一片；在有词条的地块上追问升级；升级地块按形状相连合成建筑。
 * 页面只做：取数 → 派生视图 → 画地图 → 派发交互。口径全在别处：
 *   规则 `shared/continent-world.ts`、地貌 `shared/continent-terrain.ts`、视图 `continent-view.ts`、
 *   存档与写口 `useContinentWorld.ts`、走位 `useContinentHero.ts`、答题 `MonsterDialog.tsx`、追问 `DelveDialog.tsx`。
 * ★ 词条逾期时，它落户的地块冒出「遗忘之影」——答对走既有 `api.terms.mark(id, true)`（老规则不变）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { ContinentChest } from './ContinentChest';
import { ContinentMap, type ContinentChestDrop } from './ContinentMap';
import { ContinentPartners, useContinentPartners } from './continent-partners';
import { ContinentDpad } from './continent-dpad';
import { EmberBanner, EmberDialog, TileDetail, useContinentEmber } from './continent-ember';
import { MonsterDialog } from './MonsterDialog';
import { DelveDialog } from './DelveDialog';
import { CodexPanel } from './CodexPanel';
import { BuildingGuide } from './BuildingGuide';
import { monsterName } from './monster-art';
import { buildContinentView, canStrike, manhattan, type ContinentTileView } from './continent-view';
import { useContinentHero } from './useContinentHero';
import { useContinentWorld } from './useContinentWorld';
import './continent.css';

export function ContinentPage() {
  const [terms, setTerms] = useState<ContinentMapTerm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hunting, setHunting] = useState<ContinentTileView | null>(null);
  const [detail, setDetail] = useState<ContinentTileView | null>(null);
  const [delving, setDelving] = useState<ContinentTileView | null>(null);
  const [panel, setPanel] = useState<'codex' | 'guide' | null>(null);
  const [burst, setBurst] = useState<{ row: number; col: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drops, setDrops] = useState<ContinentChestDrop[]>([]);
  const [chestAt, setChestAt] = useState<ContinentChestDrop | null>(null);
  const partners = useContinentPartners(setNotice);
  const world = useContinentWorld(setNotice);
  const [npcOpenId, setNpcOpenId] = useState<string | null>(null);
  const [recenter, setRecenter] = useState(0);

  const load = useCallback(async () => {
    try {
      const [map] = await Promise.all([api.terms.map(), world.refresh(), partners.refresh()]);
      setTerms(map.terms);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [partners.refresh, world.refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const view = useMemo(
    () => buildContinentView(terms ?? [], world.payload?.world ?? null, world.payload?.day ?? 0),
    [terms, world.payload],
  );
  const heroCtl = useContinentHero(view.tiles);
  const ember = useContinentEmber(heroCtl.hero, setNotice, () => void load());

  /** 走到目标旁边（目标本身不可站：怪 / 迷雾）——挑离英雄最近的那块相邻可站地 */
  const approach = useCallback(
    (row: number, col: number, why: string) => {
      const hero = heroCtl.hero;
      const spots = view.tiles.filter((t) => t.walkable && manhattan(t, { row, col }) === 1);
      spots.sort((a, b) => (hero ? manhattan(a, hero) - manhattan(b, hero) : 0));
      const s = spots[0];
      if (!s) return setNotice('那边还没有能站的地——先把中间的迷雾开出来。');
      heroCtl.walkTo(s.row, s.col);
      setNotice(why);
    },
    [heroCtl, view.tiles],
  );

  const solve = useCallback(
    async (tile: ContinentTileView) => {
      try {
        let msg: string;
        if (tile.wild) {
          const r = await world.slay(tile.row, tile.col);
          msg = `击败了「${monsterName(tile.species)}」——一口气开拓了 ${r?.fresh ?? 0} 块地，迷雾那头又有新的怪在游荡。`;
        } else {
          await api.terms.mark(tile.id, true);
          msg = `驱散了「${tile.term}」的遗忘之影——复习阶段推进，地上留下一个宝箱。`;
          setDrops((d) => (d.some((x) => x.row === tile.row && x.col === tile.col) ? d : [...d, { row: tile.row, col: tile.col, term: tile.term }]));
          const map = await api.terms.map();
          setTerms(map.terms);
        }
        setHunting(null);
        setBurst({ row: tile.row, col: tile.col });
        setNotice(msg);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [world],
  );

  const pick = useCallback(
    (row: number, col: number) => {
      setNotice(null);
      if (partners.placing) {
        void partners.placeAt(row, col);
        return;
      }
      if (ember.pickCell(row, col)) return;
      const drop = drops.find((d) => d.row === row && d.col === col);
      if (drop) return setChestAt(drop);
      const mate = partners.partners?.npcs.find((n) => n.row === row && n.col === col);
      if (mate) return setNpcOpenId(mate.id);
      const foe = view.monsters.find((m) => m.row === row && m.col === col) ?? view.tiles.find((t) => t.hasMonster && t.row === row && t.col === col);
      if (foe) {
        if (canStrike(heroCtl.hero, foe)) return setHunting(foe);
        return approach(row, col, '先走到怪旁边再点它开打——隔空打怪不算复习。');
      }
      const tile = view.tiles.find((t) => t.row === row && t.col === col);
      if (tile) {
        heroCtl.walkTo(row, col);
        if (tile.hasTerm) setDetail(tile);
        else setNotice('荒地：还没有词条落户。多学一条词条，它就会落在最早开拓的荒地上。');
        return;
      }
      if (view.frontier.some((f) => f.row === row && f.col === col)) {
        if (canStrike(heroCtl.hero, { row, col })) {
          void world.explore(row, col);
          return;
        }
        return approach(row, col, '走到迷雾旁边了——再点一次那格就开拓它。');
      }
      setNotice('迷雾太深了——只能开拓紧挨着你领土的格子。');
    },
    [drops, heroCtl, view, partners.partners, partners.placing, partners.placeAt, ember, approach, world],
  );

  const rescue = useCallback(
    (threatTermId: string) => {
      setNpcOpenId(null);
      const t = view.tiles.find((x) => x.id === threatTermId);
      if (!t) return setNotice('那只怪已经不在了——他也就脱险了。');
      approach(t.row, t.col, `走到「${t.term}」旁边再点它开打——答对那道题，伙伴也就脱险了。`);
    },
    [view.tiles, approach],
  );

  const stepHero = heroCtl.step;
  const frozen = hunting !== null || chestAt !== null || npcOpenId !== null || delving !== null;
  useEffect(() => {
    if (frozen) return;
    const dirs: Record<string, [number, number]> = {
      arrowup: [-1, 0], arrowdown: [1, 0], arrowleft: [0, -1], arrowright: [0, 1], w: [-1, 0], s: [1, 0], a: [0, -1], d: [0, 1],
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
          <small>从一块地开始：站到迷雾边上开拓，打倒迷雾里的怪一次开一片；在地块上追问升级，升级地连成形就能合成建筑</small>
        </h1>
        <div className="continent-stats">
          <span>已开拓 <b>{view.explored}</b></span>
          <span className={view.tokens === 0 ? 'continent-stat-warn' : ''}>开拓令 <b>{view.tokens}</b></span>
          <span>难度 <b>{view.tier}</b> 档</span>
          <span className={view.monsterCount > 0 ? 'continent-stat-warn' : ''}>怪 <b>{view.monsterCount}</b></span>
          <span>建筑 <b>{view.buildings.length}</b></span>
          <span>图鉴 <b>{view.codexFound.size}</b>/{view.codexTotal}</span>
          <button className="continent-btn" onClick={() => setPanel((p) => (p === 'codex' ? null : 'codex'))}>
            {panel === 'codex' ? '收起图鉴' : '看图鉴'}
          </button>
          <button className="continent-btn" onClick={() => setPanel((p) => (p === 'guide' ? null : 'guide'))}>
            建筑图谱
          </button>
          <button className="continent-btn ghost" onClick={() => void load()}>刷新</button>
        </div>
      </header>

      {notice && <p className="continent-banner">{notice}</p>}
      {view.tokens === 0 && view.explored > 0 && (
        <p className="continent-banner dim">开拓令用完了：每存一条新词条 +1 枚；打倒迷雾边上的怪不花开拓令，还能一次开一片。</p>
      )}
      {view.dueOutOfScope > 0 && (
        <p className="continent-banner dim">
          还有 {view.dueOutOfScope} 条到期词条没纳入复习范围，它们的地块不冒遗忘之影——在「词条」页勾进复习范围后就会出现。
        </p>
      )}
      {drops.length > 0 && <p className="continent-banner dim">地上有 {drops.length} 个宝箱——点地图上的宝箱就能开（花「每日宝箱」钥匙）。</p>}

      <EmberBanner ember={ember} />
      <ContinentPartners
        partners={partners.partners} tokens={partners.tokens} distressed={partners.distressed}
        npcOpenId={npcOpenId} placing={partners.placing} pick={partners.pick} onPick={partners.setPick}
        onClose={() => setNpcOpenId(null)} onRescue={rescue}
        onRename={partners.rename} onRemove={partners.remove}
        onStartCreate={partners.startCreate} onCancelCreate={partners.cancelCreate}
        onLibraryChanged={() => void load()} onNotice={setNotice}
      />

      {error && <p className="continent-banner warn">地图加载失败：{error}</p>}
      {terms === null && !error && <p className="continent-banner dim">正在展开大陆…</p>}
      {terms !== null && view.total === 0 && (
        <p className="continent-banner dim">
          你站在大陆的第一块地上，四周都是迷雾。先去「词条」页或在对话里存几条词条——每条词条 = 1 枚开拓令，迷雾里的怪也要靠词条出题才会现身。
        </p>
      )}

      <div className={panel ? 'continent-body with-codex' : 'continent-body'}>
        <ContinentMap
          view={view}
          hero={heroCtl.hero}
          heroFrom={heroCtl.animFrom}
          heroStart={heroCtl.animStart}
          chests={drops}
          npcs={partners.marks}
          placeSpots={partners.placeSpots}
          ember={ember.mark}
          recenterTick={recenter}
          onPick={pick}
          burst={burst}
          focus={hunting ?? detail}
          alert={heroCtl.blocked}
          fresh={world.fresh}
          glow={world.glow}
        />
        {panel === 'codex' && <CodexPanel found={view.codexFound} onClose={() => setPanel(null)} />}
        {panel === 'guide' && (
          <BuildingGuide buildings={view.buildings} tier={view.tier} nextTier={view.nextTier} explored={view.explored} onClose={() => setPanel(null)} />
        )}
      </div>

      <ContinentDpad onStep={heroCtl.step} onHalt={heroCtl.halt} onRecenter={() => setRecenter((n) => n + 1)} queued={heroCtl.queued} />

      {hunting && <MonsterDialog tile={hunting} pool={terms ?? []} onSolved={solve} onClose={() => setHunting(null)} />}
      {detail && (
        <TileDetail
          tile={detail}
          onClose={() => setDetail(null)}
          onNotice={setNotice}
          onDelve={() => {
            setDelving(detail);
            setDetail(null);
          }}
        />
      )}
      {delving && (
        <DelveDialog
          tile={delving}
          onClose={() => setDelving(null)}
          onLeveled={(lv, w) => {
            world.leveled(delving.row, delving.col, lv, w);
            setDelving(null);
          }}
        />
      )}
      {ember.open && ember.spot && (
        <EmberDialog spot={ember.spot} onKeep={ember.keep} onThank={ember.thank} onHide={ember.hide} onClose={ember.close} />
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
