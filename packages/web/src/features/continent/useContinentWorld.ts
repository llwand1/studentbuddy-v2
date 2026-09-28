/**
 * features/continent/useContinentWorld — 开拓制大陆的存档与三个写口（开拓 / 打野怪 / 追问升级）。
 *
 * ★ 每个写口都**换整份存档**（服务端回的就是新存档），并把「刚开出来的格」「刚升级的格」交给地图
 *   去播过渡；跨过难度档、建成新建筑时各说一句话（变化要被看见，也要被说出来）。
 */
import { useCallback, useRef, useState } from 'react';
import { BUILDING_INFO, detectBuildings, exploredCount, tierFor, type WorldSave } from '@sb/shared';
import { api } from '../../lib/api';
import type { WorldPayload } from '../../lib/api-continent';
import type { ContinentCell } from './continent-view';

export interface ContinentWorldCtl {
  payload: WorldPayload | null;
  fresh: ContinentCell[] | null;
  glow: ContinentCell | null;
  refresh: () => Promise<void>;
  explore: (row: number, col: number) => Promise<void>;
  slay: (row: number, col: number) => Promise<{ fresh: number; species: string } | null>;
  leveled: (row: number, col: number, lv: number, world: WorldSave) => void;
}

/** 两份存档之间发生了什么（跨档 / 新建筑）——给横幅用的一句话 */
function changeNote(before: WorldSave | null, after: WorldSave): string {
  if (!before) return '';
  const parts: string[] = [];
  const t0 = tierFor(exploredCount(before));
  const t1 = tierFor(exploredCount(after));
  if (t1 > t0) parts.push(`大陆扩张到第 ${t1} 档——迷雾里的怪更多、种类更多、血也更厚了。`);
  const had = new Set(detectBuildings(before).map((b) => `${b.kind}@${b.anchor.row},${b.anchor.col}`));
  for (const b of detectBuildings(after)) {
    if (!had.has(`${b.kind}@${b.anchor.row},${b.anchor.col}`)) parts.push(`建成了「${BUILDING_INFO[b.kind].name}」：${BUILDING_INFO[b.kind].effect}。`);
  }
  return parts.join(' ');
}

export function useContinentWorld(onNotice: (text: string) => void): ContinentWorldCtl {
  const [payload, setPayload] = useState<WorldPayload | null>(null);
  const [fresh, setFresh] = useState<ContinentCell[] | null>(null);
  const [glow, setGlow] = useState<ContinentCell | null>(null);
  const ref = useRef<WorldPayload | null>(null);
  ref.current = payload;

  const apply = useCallback((next: WorldPayload): string => {
    const note = changeNote(ref.current?.world ?? null, next.world);
    ref.current = next;
    setPayload(next);
    return note;
  }, []);

  const refresh = useCallback(async () => {
    const r = await api.continent.world();
    ref.current = r;
    setPayload(r);
  }, []);

  const explore = useCallback(
    async (row: number, col: number) => {
      try {
        const r = await api.continent.explore(row, col);
        const note = apply(r);
        setFresh(r.fresh);
        onNotice(`开拓了一块新地。${note}`.trim());
      } catch (e) {
        onNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [apply, onNotice],
  );

  const slay = useCallback(
    async (row: number, col: number) => {
      const day = ref.current?.day ?? 0;
      const r = await api.continent.slay(row, col, day);
      const note = apply(r);
      setFresh(r.fresh);
      if (note) onNotice(note);
      return { fresh: r.fresh.length, species: r.species };
    },
    [apply],
  );

  const leveled = useCallback(
    (row: number, col: number, lv: number, world: WorldSave) => {
      const prev = ref.current;
      const note = apply({ world, termCount: prev?.termCount ?? 0, day: prev?.day ?? 0 });
      setGlow({ row, col });
      onNotice(`地块升到 ${lv} 级。${note || (lv >= 1 ? '把几块升级地按特定形状连起来，就能合成建筑（看「建筑图谱」）。' : '')}`);
    },
    [apply, onNotice],
  );

  return { payload, fresh, glow, refresh, explore, slay, leveled };
}
