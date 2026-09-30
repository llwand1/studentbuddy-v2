/**
 * features/continent/ContinentPage — 知识大陆独立页（侧栏一级入口）。
 *
 * 页面只做四件事：**取数 → 派生视图 → 画地图 → 派发交互**。口径全在别处：
 *   取数 `api.terms.map()`、派生 `continent-view.ts`、出题/判分 `shared/continent.ts`、走位 `useContinentHero.ts`、
 *   绘制 `continent-canvas.ts`、相机 `useContinentCamera.ts`、答题 `MonsterDialog.tsx`、图鉴 `CodexPanel.tsx`、宝箱 `ContinentChest.tsx`、
 *   开拓 `ExpandDialog.tsx`（2026-09-29）。
 *
 * ★ 收复一律走既有 `api.terms.mark(id, true)`。答对 ⇒ 阶段推进 ⇒ 状态离开 due/overdue ⇒ 怪消失、领地回归；
 *   宝箱也走 `POST /api/cards/chest/open`（SPEC §4.2 零新表零迁移）。
 * ★ **野怪**（2026-09-29）：范围外的词条也会被野怪盯上，打赢它 = 先 `scopeTerm(id, true)` 纳入范围、再 `mark`——
 *   弹窗里提前说了这一句，所以不是替用户偷偷勾选；范围内的野怪只是提前复习一次。
 * ★ 打卡失败**不吞**：`mark` 对范围外词条会 409（正常路径已被上一条堵住），真出现也要把话念出来，而不是"点了没反应"。
 * ★ **点地走位**与**打怪**共用一次点击（够得着开打、够不着先走过去）；被挡也要说话（`heroCtl.blocked`），不许静默。
 * ★ 开拓写口在 `/api/continent/expand/*`（服务端出词、出题、重判、落库、钉住）；本页只负责"点了哪枚 +"与事后重取地图。
 * ★ 2026-09-30：**导航**（`useContinentHunt` + `ContinentNav`：寻路走过去、到了自动开打、一键讨伐队列；对话页的
 *   「一键讨伐」经 `continent-hunt-store` 把名单交到这里）、**废墟重建**（点废墟 ⇒ 同一场战斗，打赢＝复习＝原地重建）、
 *   **话题怪**（打赢与野怪同一条路：范围外先纳入再打卡）。横版战斗的转场与战场在 `MonsterDialog` / `BattleStage`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SPELL_KIND_META, localDayKey, type ContinentExpandOffer, type SpellKind } from '@sb/shared';
import { api } from '../../lib/api';
import type { ContinentMapPayload } from '../../lib/api-terms-continent';
import { ContinentChest } from './ContinentChest';
import { ContinentDetail } from './ContinentDetail';
import { ContinentHeader } from './ContinentHeader';
import { ContinentMap, type ContinentChestDrop } from './ContinentMap';
import { ContinentNav } from './ContinentNav';
import { ContinentPartners, useContinentPartners } from './continent-partners';
import { ContinentDpad } from './continent-dpad';
import { ExpandDialog } from './ExpandDialog';
import { MonsterDialog } from './MonsterDialog';
import { CodexPanel } from './CodexPanel';
import { buildContinentView, canStrike, fightTile, type ContinentBurst, type ContinentTileView } from './continent-view';
import { useContinentHero } from './useContinentHero';
import { useContinentHunt } from './useContinentHunt';
import { useContinentKeys } from './useContinentKeys';
import './continent.css';

export function ContinentPage() {
  /** 地图原料（词条 + 钉子）；`null` = 还没取到 */
  const [data, setData] = useState<ContinentMapPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 打怪弹窗（有怪的地块，或"点领地 → 打领主"） */
  const [hunting, setHunting] = useState<ContinentTileView | null>(null);
  /** 开拓弹窗（点了边界上的哪枚「+」） */
  const [expanding, setExpanding] = useState<{ row: number; col: number } | null>(null);
  /** 普通地块的详情卡（已收复 / 范围外） */
  const [detail, setDetail] = useState<ContinentTileView | null>(null);
  /** 右侧面板：图鉴 / 导航 二选一 */
  const [panel, setPanel] = useState<'none' | 'codex' | 'nav'>('none');
  const showCodex = panel === 'codex';
  const [burst, setBurst] = useState<ContinentBurst | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 地上掉落的宝箱（本局打怪留下的位置；**不落库**——开箱走既有账本） */
  const [drops, setDrops] = useState<ContinentChestDrop[]>([]);
  const [chestAt, setChestAt] = useState<ContinentChestDrop | null>(null);
  /**
   * 学习伙伴（取数/呈现/选位态整体在 `continent-partners.tsx`；这里只要一个 id 来关键盘走位）。
   * ★ 注入 `setNotice`：创建成功与失败的话都从这一条横幅说出去（伙伴那一族不自己造第二条通道）。
   */
  const partners = useContinentPartners(setNotice);
  const [npcOpenId, setNpcOpenId] = useState<string | null>(null);
  /** 「回到我身上」的计数（自增一次＝按了一次；相机规则在 `useContinentCamera`，页面不碰相机） */
  const [recenter, setRecenter] = useState(0);

  const load = useCallback(async () => {
    try {
      // ★ 地图与伙伴并发取（伙伴那一口自己并发取两处，见 `continent-partners.tsx`）
      const [map] = await Promise.all([api.terms.map(), partners.refresh()]);
      // ★ `pins ?? []`：老服务端（或用例桩）不带钉子时也要能铺——缺钉子只是全走螺旋，不是错误
      setData({ terms: map.terms, pins: map.pins ?? [] });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [partners.refresh]);

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
  // ★ 野怪的日历键在这里取（派生层不读时钟）：同一天怎么刷新都是同几只，过了午夜下次取数就换一批
  const dayKey = localDayKey(new Date());
  const terms = data?.terms;
  const pins = data?.pins;
  const baseView = useMemo(() => buildContinentView(terms ?? [], { pins, dayKey }), [terms, pins, dayKey]);
  const heroCtl = useContinentHero(baseView.tiles);
  const view = useMemo(
    () => buildContinentView(terms ?? [], { hero: heroCtl.hero, pins, dayKey }),
    [terms, pins, dayKey, heroCtl.hero],
  );

  /** 开打：怪照原样；废墟就地立一只"废墟守卫"（`fightTile`），同一场战斗打赢＝复习＝重建；到了就把「正在赶往」那句收掉 */
  const openFight = useCallback((tile: ContinentTileView) => {
    setNotice(null);
    setHunting(fightTile(tile));
  }, []);

  /** 导航（寻路 + 到了自动开打 + 一键讨伐队列）；横幅走同一个 `setNotice` */
  const hunt = useContinentHunt(view.tiles, heroCtl, openFight, setNotice);

  /** 全部答对：打卡 → 关弹窗 → 播特效（咒语补刀放该款式的咒语版）→ 地上留一箱 → 重取地图（怪随之消失、领地回归）→ 队列里还有就去下一只 */
  const solve = useCallback(
    async (tile: ContinentTileView, spell?: SpellKind) => {
      try {
        // ★ 范围外的词条（野怪 / 话题怪 / 废墟）：先纳入复习范围再打卡（否则 `mark` 必 409）。弹窗副标题已经把这一步说在前面。
        const adopted = !tile.inScope;
        if (adopted) await api.terms.scopeTerm(tile.id, true);
        await api.terms.mark(tile.id, true);
        setHunting(null);
        setBurst({ ...tile, spell });
        setDrops((d) =>
          d.some((x) => x.row === tile.row && x.col === tile.col) ? d : [...d, { row: tile.row, col: tile.col, term: tile.term }],
        );
        const hit = spell ? `「${SPELL_KIND_META[spell].name}」命中，` : '';
        const scoped = adopted ? '，这条词条已纳入复习范围' : '';
        setNotice(
          tile.monsterKind === 'wild'
            ? `${hit}打跑了野怪「${tile.term}」——算你提前复习了一次${scoped}，地上留下一个宝箱。`
            : tile.monsterKind === 'topic'
              ? `${hit}打跑了话题怪「${tile.term}」——刚聊到就复习了一次${scoped}，地上留下一个宝箱。`
              : !tile.hasMonster && tile.ruin
                ? `${hit}「${tile.term}」的废墟重建了——复习一次，这块地又立起来了${scoped}，地上留下一个宝箱。`
                : `${hit}收复了「${tile.term}」——复习阶段推进，这块地回到你手里，地上留下一个宝箱。`,
        );
        await load();
        hunt.advance();
      } catch (e) {
        setNotice(`${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [load, hunt],
  );

  /** 开拓成功：新词条已落库并钉在那一格 ⇒ 关弹窗 → 回话（含来源，如实）→ 重取地图（新地块从那一格长出来） */
  const expanded = useCallback(
    async (offer: ContinentExpandOffer) => {
      setExpanding(null);
      setNotice(
        `开拓成功：「${offer.term}」在这块新地上长出来了${offer.source === 'ai' ? '（模型按邻近领域生成）' : '（来自内置词池）'}——明天起它会按曲线到期。`,
      );
      await load();
    },
    [load],
  );

  /** 点击分流：宝箱 → 打怪（够得着才开打）→ 领地（打领主）→ 空地（走过去 + 看详情） */
  const pick = useCallback(
    (row: number, col: number) => {
      setNotice(null);
      // ★ 选位态优先于一切：这一下点击的意思是"把伙伴安置在这儿"（走位/打怪/看详情都让位）
      if (partners.placing) {
        void partners.placeAt(row, col);
        return;
      }
      const drop = drops.find((d) => d.row === row && d.col === col);
      if (drop) {
        // ★ 宝箱优先于伙伴：它是**一次性**的（开了就没了），而伙伴一直站在那儿。
        //   两者同格是极小概率（怪死后那格才变成候选落位），但真撞上时先给一次性那个。
        setChestAt(drop);
        return;
      }
      const mate = partners.partners?.npcs.find((n) => n.row === row && n.col === col);
      if (mate) {
        // 点开面板 = 这句话被听见了 ⇒ 收掉话泡（服务端也清，否则下一轮轮询又送回来）
        if (partners.bubble?.npcId === mate.id) partners.dismissBubble();
        return setNpcOpenId(mate.id);
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
      if (tile?.ruin) {
        // ★ 废墟：点它就是"去重建"——够得着直接开打，够不着导航过去（同一条「靠近才开打」闸门）
        hunt.goTo(tile);
        return;
      }
      if (tile) {
        heroCtl.walkTo(row, col);
        setDetail(tile);
        return;
      }
      // ★ 边界上的「+」：这一格没有词条也没有领地，但它是开拓入口——点了就领一块（不要求英雄相邻：开拓是"规划"，不是"打"）
      if (view.frontier.some((f) => f.row === row && f.col === col)) setExpanding({ row, col });
    },
    [drops, heroCtl, hunt, view, partners.partners, partners.placing, partners.placeAt],
  );

  /** 「去救他」：★ **不代打**，只把人送到"一步能打到"的格（与「靠近才开打」同一条判断标准） */
  const rescue = useCallback((threatTermId: string) => {
    setNpcOpenId(null);
    const t = view.tiles.find((x) => x.id === threatTermId);
    if (!t) return setNotice('那只怪已经不在了——地回来了，他也就脱险了。');
    heroCtl.walkTo(t.row, t.col);
    setNotice(`走到「${t.term}」旁边再点它开打——答对那道题，伙伴也就脱险了。`);
  }, [view.tiles, heroCtl]);

  /** 键盘走位（方向键 / WASD）。弹窗开着时让位——不然打字会变成走路 */
  useContinentKeys(hunting !== null || chestAt !== null || npcOpenId !== null || expanding !== null, heroCtl.step);

  return (
    <div className="continent-page">
      <ContinentHeader
        view={view}
        panel={panel}
        onTogglePanel={(p) => setPanel((cur) => (cur === p ? 'none' : p))}
        onReload={() => void load()}
      />

      {notice && <p className="continent-banner">{notice}</p>}
      {view.dueOutOfScope > 0 && (
        <p className="continent-banner dim">
          还有 {view.dueOutOfScope} 条到期词条没纳入复习范围，它们不会冒欠账怪（只可能被野怪盯上）——
          在「词条」页把它们或所属领域勾进复习范围后，这里就会按曲线催你。
        </p>
      )}

      {drops.length > 0 && (
        <p className="continent-banner dim">
          地上有 {drops.length} 个宝箱（打怪留下的）——点地图上的宝箱就能开，花的是「每日宝箱」那本钥匙账。
        </p>
      )}

      <ContinentPartners
        partners={partners.partners} tokens={partners.tokens} distressed={partners.distressed}
        npcOpenId={npcOpenId} placing={partners.placing}
        onClose={() => setNpcOpenId(null)} onRescue={rescue}
        onRename={partners.rename} onRemove={partners.remove}
        onStartCreate={partners.startCreate} onCancelCreate={partners.cancelCreate}
        onLibraryChanged={() => void load()} onNotice={setNotice}
      />

      {error && <p className="continent-banner warn">地图加载失败：{error}</p>}
      {data === null && !error && <p className="continent-banner dim">正在展开大陆…</p>}
      {data !== null && view.total === 0 && (
        <p className="continent-banner dim">
          大陆还是一片空地。先去「词条」页添加，或在对话里存几条词条——它们会从中心长出来，
          你那位学习伙伴也在等它的第一条词条。
        </p>
      )}

      <div className={panel !== 'none' ? 'continent-body with-codex' : 'continent-body'}>
        <ContinentMap
          tiles={view.tiles}
          wildLands={view.wildLands}
          radius={view.radius}
          hero={heroCtl.hero}
          heroFrom={heroCtl.animFrom}
          heroStart={heroCtl.animStart}
          chests={drops}
          npcs={partners.marks}
          npcBubble={partners.bubble}
          placeSpots={partners.placeSpots}
          frontier={view.frontier}
          recenterTick={recenter}
          onPick={pick}
          burst={burst}
          focus={hunting ?? hunt.target ?? detail}
          alert={heroCtl.blocked}
        />
        {showCodex && <CodexPanel found={view.codexFound} onClose={() => setPanel('none')} />}
        {panel === 'nav' && <ContinentNav view={view} hero={heroCtl.hero} hunt={hunt} onClose={() => setPanel('none')} />}
      </div>

      {/* D-pad：键盘之外的走位入口（已拆成 `continent-dpad.tsx`——本文件贴 `.tsx ≤300` 红线） */}
      <ContinentDpad
        onStep={heroCtl.step}
        onHalt={heroCtl.halt}
        onRecenter={() => setRecenter((n) => n + 1)}
        queued={heroCtl.queued}
      />

      {hunting && (
        <MonsterDialog tile={hunting} pool={terms ?? []} onSolved={solve} onClose={() => setHunting(null)} />
      )}

      {expanding && <ExpandDialog cell={expanding} onExpanded={(_r, offer) => expanded(offer)} onClose={() => setExpanding(null)} />}

      {detail && <ContinentDetail tile={detail} onClose={() => setDetail(null)} />}

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