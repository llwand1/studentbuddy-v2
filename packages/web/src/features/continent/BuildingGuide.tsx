/**
 * features/continent/BuildingGuide — 「建筑图谱」：五种建筑的配方、效果与已建数量，以及难度曲线的现状。
 * 配方与效果文案只有一份（`shared/continent-world.ts#BUILDING_INFO`）。
 */
import { BUILDING_INFO, maxComboFor, monsterCapFor, qtypesFor, hpRoundsFor, CONTINENT_QLABEL, type Building, type BuildingKind } from '@sb/shared';

interface Props {
  buildings: readonly Building[];
  tier: number;
  nextTier: number | null;
  explored: number;
  onClose: () => void;
}

const KINDS: BuildingKind[] = ['camp', 'tower', 'library', 'stele', 'spire'];

export function BuildingGuide({ buildings, tier, nextTier, explored, onClose }: Props) {
  return (
    <aside className="continent-codex continent-guide" aria-label="建筑图谱">
      <header className="continent-codex-head">
        <span>
          建筑图谱
          <small>把升级过的地块按形状连起来即自动合成（同一块地只算进一座建筑）</small>
        </span>
        <button className="continent-btn ghost" onClick={onClose}>
          收起
        </button>
      </header>
      <ul className="continent-guide-list">
        {KINDS.map((k) => {
          const n = buildings.filter((b) => b.kind === k).length;
          return (
            <li key={k} className={n > 0 ? 'on' : ''}>
              <b>{BUILDING_INFO[k].name}</b>
              <span>配方：{BUILDING_INFO[k].recipe}</span>
              <span>效果：{BUILDING_INFO[k].effect}</span>
              <em>{n > 0 ? `已建 ${n} 座` : '未建'}</em>
            </li>
          );
        })}
      </ul>
      <p className="continent-guide-tier">
        难度第 {tier} 档{nextTier !== null ? `（再开 ${nextTier - explored} 格进入下一档）` : '（已满档）'}：同屏最多 {monsterCapFor(tier)} 只怪 · 组合最长{' '}
        {maxComboFor(tier)} 型 · 血量 ×{hpRoundsFor(tier)} · 可能出现：{qtypesFor(tier).map((q) => CONTINENT_QLABEL[q]).join('、')}
      </p>
      <p className="continent-guide-tier">地块等级：0 初垦 → 1 良田（木栅犁沟）→ 2 石基（石砌灯笼）→ 3 符文（发光水晶）。在有词条的地块上「追问升级」。</p>
    </aside>
  );
}
