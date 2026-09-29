/**
 * features/continent/ContinentHeader — 知识大陆页的标题与统计条（从 `ContinentPage.tsx` 拆出，2026-09-29）。
 *
 * ★ 只做呈现：数字全部来自 `buildContinentView()` 的结论（欠账怪 / 野怪 / 被占的地 / 图鉴），本组件不重算。
 * ★ 拆出的理由：页面文件贴 `.tsx ≤320` 红线；统计条是最没有交互的一段（两枚按钮只是回调）。
 */
import type { ContinentView } from './continent-view';

interface Props {
  view: ContinentView;
  showCodex: boolean;
  onToggleCodex: () => void;
  onReload: () => void;
}

export function ContinentHeader({ view, showCodex, onToggleCodex, onReload }: Props) {
  return (
    <header className="continent-head">
      <h1>
        知识大陆
        <small>
          词条从中心长出来；逾期未复习的会被怪占领并向外扩地，每天还会刷出几只野怪——走过它们旁边开打，答对就把地收回来；
          点边界上的「+」开拓新地
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
        <span className={view.wildCount > 0 ? 'continent-stat-wild' : ''} title="每天随机刷出的野怪：打赢＝提前复习一次，明天换一批">
          野怪 <b>{view.wildCount}</b>
        </span>
        <span className={view.landCount > 0 ? 'continent-stat-warn' : ''}>
          被占领的地 <b>{view.landCount}</b>
        </span>
        <span>
          图鉴 <b>{view.codexFound.size}</b>/{view.codexTotal}
        </span>
        <button className="continent-btn" onClick={onToggleCodex}>
          {showCodex ? '收起图鉴' : '看图鉴'}
        </button>
        <button className="continent-btn ghost" onClick={onReload}>
          刷新
        </button>
      </div>
    </header>
  );
}
