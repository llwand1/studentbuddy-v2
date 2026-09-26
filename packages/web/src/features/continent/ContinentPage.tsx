/**
 * features/continent/ContinentPage — 知识大陆独立页（侧栏一级入口）。
 *
 * 页面只做四件事：**取数 → 派生视图 → 画地图 → 派发交互**。所有口径都在别处：
 *   取数 `api.terms.map()`（只读端点）、派生 `continent-view.ts`、出题/判分 `shared/continent.ts`、
 *   地图渲染 `ContinentMap.tsx`、答题 `MonsterDialog.tsx`、图鉴 `CodexPanel.tsx`。
 *
 * ★ **解锁走既有打卡端点**（`api.terms.mark(id, true)`），本页**不新增任何写口**：
 *   答对 ⇒ 阶段推进 ⇒ 状态离开 due/overdue ⇒ 怪自然消失（SPEC §4.2 零新表零迁移）。
 * ★ 打卡失败**不吞**：`mark` 对范围外词条会 409，虽然地图已按服务端结论不画这类怪，
 *   但真出现（数据刚好在两次请求间被改）也要把话念出来，而不是"点了没反应"。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { ContinentMap } from './ContinentMap';
import { MonsterDialog } from './MonsterDialog';
import { CodexPanel } from './CodexPanel';
import { buildContinentView, tileStatusText, type ContinentTileView } from './continent-view';
import './continent.css';

export function ContinentPage() {
  const [terms, setTerms] = useState<ContinentMapTerm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 打怪弹窗（有怪的地块） */
  const [hunting, setHunting] = useState<ContinentTileView | null>(null);
  /** 普通地块的详情卡（已收复 / 范围外） */
  const [detail, setDetail] = useState<ContinentTileView | null>(null);
  const [showCodex, setShowCodex] = useState(false);
  const [burst, setBurst] = useState<ContinentTileView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  const view = useMemo(() => buildContinentView(terms ?? []), [terms]);

  /** 全部答对：打卡 → 关弹窗 → 播特效 → 重取地图（怪随之消失） */
  const solve = useCallback(
    async (tile: ContinentTileView) => {
      try {
        await api.terms.mark(tile.id, true);
        setHunting(null);
        setBurst({ ...tile });
        setNotice(`收复了「${tile.term}」——复习阶段推进，这块地回到你手里。`);
        await load();
      } catch (e) {
        setNotice(`${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [load],
  );

  const pick = useCallback((tile: ContinentTileView) => {
    setNotice(null);
    if (tile.hasMonster) setHunting(tile);
    else setDetail(tile);
  }, []);

  return (
    <div className="continent-page">
      <header className="continent-head">
        <h1>
          知识大陆
          <small>词条从中心长出来；逾期未复习的会被怪占领，点它复习即可收复</small>
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

      {error && <p className="continent-banner warn">地图加载失败：{error}</p>}
      {terms === null && !error && <p className="continent-banner dim">正在展开大陆…</p>}
      {terms !== null && view.total === 0 && (
        <p className="continent-banner dim">
          大陆还是一片空地。先去「词条」页添加，或在对话里存几条词条——它们会从中心长出来。
        </p>
      )}

      <div className={showCodex ? 'continent-body with-codex' : 'continent-body'}>
        <ContinentMap tiles={view.tiles} onPick={pick} burst={burst} focus={hunting ?? detail} />
        {showCodex && <CodexPanel found={view.codexFound} onClose={() => setShowCodex(false)} />}
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
    </div>
  );
}