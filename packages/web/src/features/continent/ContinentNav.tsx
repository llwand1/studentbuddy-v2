/**
 * features/continent/ContinentNav — 「导航」面板（2026-09-30，契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「导航」）。
 *
 * 大陆大了以后"图上有怪但不知道在哪"是常态：这里把图上**所有值得去的地方**列成清单——欠账怪 / 话题怪 / 野怪 /
 * 废墟——每行一个「前往」，点了英雄自己寻路走过去、到了自动开打（`useContinentHunt`）。「全部讨伐」按清单顺序
 * 一只接一只。清单是 `buildContinentView` 结论的**另一种呈现**，不重算任何口径；距离只是给人看的曼哈顿步数。
 * ★ 排序＝该先打谁：欠账怪按逾期天数降序（欠得越久占地越多）→ 话题怪（刚聊到的，趁热）→ 野怪；废墟按没碰的天数降序。
 * ★ 与图鉴同一位置、同一外壳：两块面板互斥（页面只开一块），窄屏一样自动落到地图下方。
 */
import type { ContinentHunt } from './useContinentHunt';
import { manhattan, type ContinentTileView, type ContinentView } from './continent-view';

interface Props {
  view: ContinentView;
  hero: { row: number; col: number } | null;
  hunt: ContinentHunt;
  onClose: () => void;
}

const KIND_LABEL = { due: '欠账', topic: '话题', wild: '野怪' } as const;

/** 清单顺序（也是「全部讨伐」的顺序）：欠账（逾期久的先）→ 话题 → 野怪 */
export function huntOrder(tiles: readonly ContinentTileView[]): ContinentTileView[] {
  const rank = { due: 0, topic: 1, wild: 2 } as const;
  return tiles
    .filter((t) => t.hasMonster && t.monsterKind)
    .sort((a, b) => {
      const ka = rank[a.monsterKind!];
      const kb = rank[b.monsterKind!];
      if (ka !== kb) return ka - kb;
      if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays;
      return a.id < b.id ? -1 : 1;
    });
}

export function ContinentNav({ view, hero, hunt, onClose }: Props) {
  const monsters = huntOrder(view.tiles);
  const ruins = view.tiles.filter((t) => t.ruin && !t.hasMonster).sort((a, b) => b.daysSince - a.daysSince || (a.id < b.id ? -1 : 1));
  const dist = (t: ContinentTileView): string => (hero ? `${manhattan(hero, t)} 步` : '');

  return (
    <aside className="continent-nav" aria-label="导航">
      <div className="continent-nav-head">
        <div>
          <b>导航</b>
          <small>点「前往」英雄自己走过去，到了旁边自动开打；「全部讨伐」按清单顺序一只接一只。</small>
        </div>
        <button className="continent-btn ghost" onClick={onClose}>
          收起
        </button>
      </div>

      <div className="continent-nav-group">
        <h4>怪 {monsters.length}</h4>
        {monsters.length === 0 && <p className="continent-nav-empty">图上暂时没有怪——去对话里聊几条词条，明天也会刷出野怪。</p>}
        {monsters.map((t) => (
          <div key={t.id} className={`continent-nav-row${hunt.target?.id === t.id ? ' is-target' : ''}`}>
            <span className={`continent-nav-kind ${t.monsterKind ?? ''}`}>{KIND_LABEL[t.monsterKind ?? 'wild']}</span>
            <b title={`${t.term} · ${t.domain}`}>{t.term}</b>
            <em>
              {t.level} 级{t.monsterKind === 'due' && t.overdueDays > 0 ? ` · 逾期 ${t.overdueDays} 天` : ''} · {dist(t)}
            </em>
            <button className="continent-btn" onClick={() => hunt.goTo(t)} disabled={!hero}>
              前往
            </button>
          </div>
        ))}
      </div>

      <div className="continent-nav-group">
        <h4>废墟 {ruins.length}</h4>
        {ruins.length === 0 && <p className="continent-nav-empty">没有碎掉的地块——越靠边的地耐久越短，常回来看看。</p>}
        {ruins.map((t) => (
          <div key={t.id} className={`continent-nav-row${hunt.target?.id === t.id ? ' is-target' : ''}`}>
            <span className="continent-nav-kind ruin">废墟</span>
            <b title={`${t.term} · ${t.domain}`}>{t.term}</b>
            <em>
              {t.daysSince} 天没碰 · {dist(t)}
            </em>
            <button className="continent-btn" onClick={() => hunt.goTo(t)} disabled={!hero}>
              重建
            </button>
          </div>
        ))}
      </div>

      <div className="continent-nav-foot">
        <button className="continent-btn primary" disabled={monsters.length === 0 || !hero} onClick={() => hunt.startQueue(monsters.map((t) => t.id))}>
          全部讨伐（{monsters.length}）
        </button>
        {(hunt.target || hunt.queued > 0) && (
          <button className="continent-btn ghost" onClick={hunt.cancel}>
            取消导航{hunt.queued > 0 ? `（还剩 ${hunt.queued} 只）` : ''}
          </button>
        )}
      </div>
    </aside>
  );
}
