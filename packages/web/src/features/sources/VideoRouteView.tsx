/**
 * VideoRouteView —— 资料架里的「视频线路」（契约 docs/SOURCE-TRACE-SPEC.md §12.3）。
 *
 * 一条搜索条（词 + 两条线路 + 搜）、命中卡片列表、B站命中点开就地播（官方播放器 iframe，与架上视频同一套沙箱）。
 * 两家的差别摆在明处：B站卡片是「播」，抖音卡片右上角一个 ↗、点了开新标签页，说明条写清「抖音不开放接口、不许嵌播」。
 * 零命中不是死胡同：`siteSearchUrl` 永远在，一键去站内搜。
 *
 * 只认 store 形状与 `@sb/shared` 的纯函数，不碰网络（搜索由 store 发）。
 */
import { VIDEO_ROUTES, VIDEO_ROUTE_META, cleanVideoQuery, formatPlays, videoEmbedUrl, videoSiteSearchUrl, type VideoHit } from '@sb/shared';
import { playVideo, runVideoSearch, setVideoQuery, setVideoRoute, type VideoRouteState } from '../../lib/video-route-store';

const openTab = (url: string): void => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

function HitCard({ hit, active }: { hit: VideoHit; active: boolean }) {
  const meta = VIDEO_ROUTE_META[hit.route];
  const bits = [hit.author, hit.duration, hit.plays !== undefined ? `${formatPlays(hit.plays)}播放` : ''].filter(Boolean).join(' · ');
  return (
    <li>
      <button
        type="button"
        className={`vr-card${active ? ' active' : ''}${meta.playable ? '' : ' jump'}`}
        aria-pressed={meta.playable ? active : undefined}
        title={`${hit.title}\n${hit.url}`}
        onClick={() => (meta.playable ? playVideo(hit) : openTab(hit.url))}
      >
        {hit.cover ? (
          <img className="vr-cover" src={hit.cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className={`vr-cover vr-cover-blank route-${hit.route}`} aria-hidden="true">
            {meta.label}
          </span>
        )}
        <span className="vr-card-body">
          <span className="vr-title">{hit.title}</span>
          {bits && <span className="vr-meta">{bits}</span>}
          {!bits && hit.snippet && <span className="vr-meta">{hit.snippet}</span>}
        </span>
        <span className="vr-act" aria-hidden="true">
          {meta.playable ? (active ? '播放中' : '播') : '↗'}
        </span>
      </button>
    </li>
  );
}

export function VideoRouteView({ st }: { st: VideoRouteState }) {
  const meta = VIDEO_ROUTE_META[st.route];
  const embed = st.playing ? videoEmbedUrl(st.playing.url) : null;
  const canSearch = st.query.trim().length > 0 && st.phase !== 'loading';
  // 站内搜索页永远给得出（没搜成也给）：零命中 / 出错都不该是死胡同
  const siteQuery = st.result?.query ?? cleanVideoQuery(st.query);
  const siteUrl = st.result?.siteSearchUrl ?? (siteQuery ? videoSiteSearchUrl(st.route, siteQuery) : '');
  return (
    <div className="vr" aria-label="视频线路">
      <form
        className="vr-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSearch) void runVideoSearch();
        }}
      >
        <input
          className="vr-input"
          type="search"
          value={st.query}
          onChange={(e) => setVideoQuery(e.target.value)}
          placeholder="想看哪个知识点的讲解视频？"
          aria-label="视频搜索词"
          maxLength={80}
          autoComplete="off"
        />
        <span className="vr-routes" role="radiogroup" aria-label="线路">
          {VIDEO_ROUTES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={st.route === r}
              className={`vr-route${st.route === r ? ' active' : ''}`}
              title={VIDEO_ROUTE_META[r].hint}
              onClick={() => setVideoRoute(r)}
            >
              {VIDEO_ROUTE_META[r].label}
            </button>
          ))}
        </span>
        <button type="submit" className="vr-go" disabled={!canSearch}>
          搜
        </button>
      </form>
      {embed && st.playing && (
        <iframe
          key={embed}
          className="sb-browser-frame src-frame vr-player"
          src={embed}
          title={st.playing.title}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          allow="fullscreen; picture-in-picture; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin"
        />
      )}
      <div className={`vr-body${embed ? ' with-player' : ''}`}>
        {st.phase === 'idle' && <p className="vr-hint">{st.query ? `按「搜」在${meta.label}找「${st.query}」` : `输入知识点，去${meta.label}找讲解视频 · ${meta.hint}`}</p>}
        {st.phase === 'loading' && (
          <p className="vr-wait" role="status">
            在{meta.label}找「{st.query}」…
          </p>
        )}
        {st.phase === 'error' && (
          <p className="vr-note error" role="alert">
            视频线路没搜成：{st.error}
          </p>
        )}
        {st.phase === 'done' && st.result && (
          <>
            {st.result.note && <p className={`vr-note${st.result.via === 'none' ? ' none' : ''}`}>{st.result.note}</p>}
            {st.result.hits.length > 0 && (
              <ul className="vr-list">
                {st.result.hits.map((h) => (
                  <HitCard key={h.url} hit={h} active={st.playing?.url === h.url} />
                ))}
              </ul>
            )}
          </>
        )}
        {(st.phase === 'done' || st.phase === 'error') && siteUrl && (
          <a className="vr-card jump vr-site" href={siteUrl} target="_blank" rel="noopener noreferrer" title={siteUrl}>
            <span className={`vr-cover vr-cover-blank route-${st.route}`} aria-hidden="true">
              {meta.label}
            </span>
            <span className="vr-card-body">
              <span className="vr-title">去{meta.label}站内搜「{siteQuery}」</span>
              <span className="vr-meta">在新标签页打开{meta.label}自己的搜索结果</span>
            </span>
            <span className="vr-act" aria-hidden="true">
              ↗
            </span>
          </a>
        )}
      </div>
    </div>
  );
}
