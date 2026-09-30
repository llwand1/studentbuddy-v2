/**
 * features/continent/useContinentHunt — 「导航到怪 → 到了自动开打」与「一键讨伐」队列（2026-09-30，
 * 契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「导航」§「话题怪」）。
 *
 * 用户原话："知识大陆加导航，可以直接导航到怪物并进行战斗"。口径：
 *   · **导航**＝寻路（`continent-path.ts` 的 BFS）+ 走位（`useContinentHero.follow`）+ **到了自动开打**（`openFight`）。
 *     "靠近才开打"这条闸门不破：自动开打发生在英雄真的走到相邻格之后，导航只是替你按方向键。
 *   · **到不了要说话**（ADR-5）：领地围死了 ⇒ 横幅说"走不到，先清挡路的怪"，目标仍高亮让你看见它在哪。
 *   · **一键讨伐**＝一串目标：打赢一只（页面在 `solve` 成功后调 `advance()`）就接着导航去下一只；
 *     名单来自对话页（`continent-hunt-store.takeHunt`），本页一挂好英雄就取走。
 *   · 目标在途中消失（别人替你复习了 / 换天了）⇒ 说一句、跳过。
 * ★ 纯前端、零存储：导航状态与英雄位置一样只活在会话里。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { canStrike, type ContinentTileView } from './continent-view';
import { pathToStrike } from './continent-path';
import { takeHunt } from './continent-hunt-store';
import type { ContinentHero } from './useContinentHero';

export interface ContinentHunt {
  /** 正在导航去打的那一格（地图高亮 + 横幅）；没在导航 ⇒ `null` */
  target: ContinentTileView | null;
  /** 一键讨伐队列里**还没轮到**的只数 */
  queued: number;
  /** 导航到某一格：够得着就直接开打，否则寻路走过去、到了自动开打；到不了说话 */
  goTo: (tile: ContinentTileView) => void;
  /** 一键讨伐：按顺序导航 + 开打 */
  startQueue: (ids: readonly string[]) => void;
  /** 打赢一只之后接着去下一只（页面在打卡成功、地图重取之后调） */
  advance: () => void;
  /** 取消导航与队列 */
  cancel: () => void;
}

/** 值得导航过去的格：有怪、是废墟（复习重建）、或是领地（打领主） */
function huntable(t: ContinentTileView): boolean {
  return t.hasMonster || t.ruin || t.isLand;
}

export function useContinentHunt(
  tiles: readonly ContinentTileView[],
  heroCtl: Pick<ContinentHero, 'hero' | 'queued' | 'follow' | 'halt'>,
  openFight: (tile: ContinentTileView) => void,
  notice: (msg: string) => void,
): ContinentHunt {
  const [targetId, setTargetId] = useState<string | null>(null);
  /** 目标走不到（围死）：仍高亮给用户看，但"到了就开打"的 effect 不该把它当成"停下来了" */
  const [stuck, setStuck] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  /** `advance()` 之后等着地图刷新再出发（用 tick 驱动 effect，而不是在 async 回调里读旧 tiles） */
  const [advanceTick, setAdvanceTick] = useState(0);
  const handledTickRef = useRef(0);
  const tookRef = useRef(false);
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const heroRef = useRef(heroCtl.hero);
  heroRef.current = heroCtl.hero;

  const goTo = useCallback(
    (tile: ContinentTileView) => {
      const hero = heroRef.current;
      if (!hero) return;
      if (canStrike(hero, tile)) {
        setTargetId(null);
        setStuck(false);
        openFight(tile);
        return;
      }
      const path = pathToStrike(tilesRef.current, hero, tile);
      setTargetId(tile.id);
      if (path === null) {
        setStuck(true);
        heroCtl.halt();
        notice(`走不到「${tile.term}」旁边——荒地或别的怪的领地围住了它，先清掉挡路的怪再来（它在地图上已高亮）。`);
        return;
      }
      setStuck(false);
      heroCtl.follow(path);
      notice(`正在赶往「${tile.term}」（${path.length} 步）——到了旁边会自动开打。`);
    },
    [heroCtl, openFight, notice],
  );

  /** 按 id 出发；目标不在了就说一句并返回 false（队列据此跳过） */
  const goToId = useCallback(
    (id: string): boolean => {
      const tile = tilesRef.current.find((t) => t.id === id);
      if (!tile || !huntable(tile)) {
        notice(tile ? `「${tile.term}」那儿已经没有怪了（可能刚复习过），跳过。` : '那只怪已经不在图上了，跳过。');
        return false;
      }
      goTo(tile);
      return true;
    },
    [goTo, notice],
  );

  const startQueue = useCallback(
    (ids: readonly string[]) => {
      const rest = [...ids];
      while (rest.length > 0) {
        const id = rest.shift()!;
        if (goToId(id)) break;
      }
      setQueue(rest);
    },
    [goToId],
  );

  const advance = useCallback(() => setAdvanceTick((n) => n + 1), []);

  const cancel = useCallback(() => {
    setTargetId(null);
    setStuck(false);
    setQueue([]);
    heroCtl.halt();
  }, [heroCtl]);

  // 到了旁边 ⇒ 开打；停下来却没到（被挡 / 地形变了）⇒ 说话并放弃这一次导航（围死的目标不在此列：它压根没出发）
  useEffect(() => {
    if (!targetId || stuck || heroCtl.queued > 0) return;
    const tile = tiles.find((t) => t.id === targetId);
    const hero = heroCtl.hero;
    if (!tile || !hero) return;
    setTargetId(null);
    if (canStrike(hero, tile) && huntable(tile)) openFight(tile);
    else if (huntable(tile)) notice(`没走到「${tile.term}」旁边就停下了——路被堵住了，先清掉挡路的怪。`);
  }, [targetId, stuck, heroCtl.queued, heroCtl.hero, tiles, openFight, notice]);

  // 打赢一只之后：地图已重取 ⇒ 出发去队列里的下一只
  useEffect(() => {
    if (advanceTick === handledTickRef.current) return;
    handledTickRef.current = advanceTick;
    if (queue.length === 0) return;
    startQueue(queue);
  }, [advanceTick, queue, startQueue]);

  // 从对话页带着名单进来：英雄就位后取一次
  const ready = heroCtl.hero !== null && tiles.length > 0;
  useEffect(() => {
    if (!ready || tookRef.current) return;
    tookRef.current = true;
    const ids = takeHunt();
    if (ids && ids.length > 0) startQueue(ids);
  }, [ready, startQueue]);

  return {
    target: targetId ? tiles.find((t) => t.id === targetId) ?? null : null,
    queued: queue.length,
    goTo,
    startQueue,
    advance,
    cancel,
  };
}
