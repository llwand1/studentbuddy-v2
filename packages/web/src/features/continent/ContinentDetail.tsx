/**
 * features/continent/ContinentDetail — 普通地块的详情卡（已收复 / 范围外），2026-09-30 从 `ContinentPage.tsx` 拆出。
 *
 * ★ 拆出的理由只有一个：页面文件贴 `.tsx ≤320` 红线（导航 + 废墟 + 话题怪进来之后越线）。
 *   它没有任何口径：副标题走 `tileStatusText`（唯一文案源），释义原样。
 */
import { tileStatusText, type ContinentTileView } from './continent-view';

interface Props {
  tile: ContinentTileView;
  onClose: () => void;
}

export function ContinentDetail({ tile, onClose }: Props) {
  return (
    <div className="continent-detail">
      <span className="continent-modal-title">
        {tile.term}
        <small>
          {tile.domain} · {tileStatusText(tile)}
        </small>
      </span>
      <p className="continent-detail-def">{tile.definition}</p>
      <button className="continent-btn ghost" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}
