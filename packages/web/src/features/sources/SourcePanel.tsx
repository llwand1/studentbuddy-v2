/**
 * SourcePanel — 应用右侧「资料架」：AI 联网时搜到 / 读过 / 精选的资料在这里逐条可看（契约 docs/SOURCE-TRACE-SPEC.md §8）。
 *
 * 与内置浏览器（PreviewPanel）同一块位置、同一套外壳样式（`.sb-browser`），但内容按资料类型分三路：
 *  - 网页 / 图片 → 服务端阅读页 `/api/sources/view`（零脚本文档 + CSP sandbox，iframe 再叠 sandbox），
 *    打不开时由 `ReaderFrame` 换成**服务器截图**（2026-09-30 截图保底，§13）；
 *  - 视频 → 官方播放器（youtube-nocookie / player.bilibili），需要脚本与同源才能播；
 *  - PDF → `/api/sources/pdf` 转发，**不加 sandbox 属性**（浏览器的 PDF 查看器在沙箱 iframe 里是禁用的；
 *    服务端已校验魔数、nosniff，只会是 PDF 字节）。
 * 「原网页」按钮永远在：阅读模式拿不全（脚本渲染页）时一键去看原站。
 * 每个标签旁有一个 ✕（2026-09-30）：架子堆多了要能**一条条**清走没用的（整面板的 × 只是收起）。
 *
 * 「存为资料」（2026-10-02，DOC-RAG-SPEC §10）：架子上翻到「就它了」的那一页，可以就地设成
 * **本会话的学习资料**——之后的回答与出题都以它为准。它写的是文档模式、不碰架子本身（两个语义）。
 *
 * 「视频线路」（2026-09-30，§12）：同一块面板的第二种内容——学习者自己去 B站 / 抖音找讲解视频。
 * 打开时替换架子视图（头部「资料 n」一键切回），架子本身状态不动；没有架子也能单独打开（消息脚注「找视频」）。
 *
 * 与演示面板的关系：两者同占右栏，演示是用户点出来的、优先级更高——有演示时本面板让位（返回 null），
 * 演示关掉就回来（store 状态没丢）。
 */
import { useSyncExternalStore } from 'react';
import { orderSources, videoEmbedUrl, type SourceItem } from '@sb/shared';
import { getPreview, subscribePreview } from '../../lib/preview-store';
import { closeSources, readerUrl, removeSource, selectSource, useSources } from '../../lib/sources-store';
import { closeVideoRoute, openVideoRoute, useVideoRoute } from '../../lib/video-route-store';
import { ReaderFrame } from './ReaderFrame';
import { SaveAsDocButton } from './SaveAsDocButton';
import { VideoRouteView } from './VideoRouteView';
import { useSourceKeys } from './useSourceKeys';
import '../preview/panel.css';
import './sources.css';

const KIND_GLYPH: Record<SourceItem['kind'], string> = { page: '文', video: '视', pdf: 'PDF', image: '图' };
const KIND_LABEL: Record<SourceItem['kind'], string> = { page: '网页', video: '视频', pdf: 'PDF', image: '图片' };

function SourceFrame({ sessionId, item }: { sessionId: string; item: SourceItem }) {
  const embed = item.kind === 'video' ? videoEmbedUrl(item.url) : null;
  if (embed) {
    return (
      <iframe
        key={embed}
        className="sb-browser-frame src-frame"
        src={embed}
        title={item.title}
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        allow="fullscreen; picture-in-picture; encrypted-media"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    );
  }
  if (item.kind === 'pdf') {
    const src = readerUrl(sessionId, item);
    return <iframe key={src} className="sb-browser-frame src-frame" src={src} title={item.title} />;
  }
  return <ReaderFrame sessionId={sessionId} item={item} />;
}

export function SourcePanel() {
  const st = useSources();
  const vr = useVideoRoute();
  const preview = useSyncExternalStore(subscribePreview, getPreview, getPreview);
  const hasShelf = st.open && st.items.length > 0;
  const videoMode = vr.open;
  const visible = (hasShelf || videoMode) && !preview;
  useSourceKeys(visible && !videoMode);
  if (!visible) return null;

  const ordered = orderSources(st.items);
  const active = ordered.find((s) => s.n === st.activeN) ?? ordered[0];
  const closeAll = (): void => {
    closeVideoRoute();
    closeSources();
  };

  if (videoMode) {
    return (
      <aside className="sb-browser sb-sources sb-video-route" aria-label="视频线路">
        <header className="sb-browser-head">
          <span className="sb-browser-badge">视频</span>
          <span className="sb-browser-title" title={vr.playing?.url ?? ''}>
            {vr.playing ? vr.playing.title : vr.query ? `找「${vr.query}」的讲解视频` : '找讲解视频'}
          </span>
          <span className="sb-browser-actions">
            {vr.playing && (
              <button className="sb-browser-btn" onClick={() => window.open(vr.playing?.url ?? '', '_blank', 'noopener,noreferrer')} title="在新标签页打开视频页">
                原网页
              </button>
            )}
            {hasShelf && (
              <button className="sb-browser-btn" onClick={closeVideoRoute} title="回到这条回答的资料架">
                资料 {ordered.length}
              </button>
            )}
            <button className="sb-browser-btn sb-browser-close" onClick={closeAll} title="关闭">
              ×
            </button>
          </span>
        </header>
        <VideoRouteView st={vr} />
        <footer className="src-foot">
          <span>B站：就地播 · 抖音：跳转看</span>
        </footer>
      </aside>
    );
  }

  if (!active) return null;
  const note = active.origin === 'pick' && active.why ? `★ AI 精选：${active.why}` : active.snippet ? active.snippet : `${KIND_LABEL[active.kind]} · ${active.site}`;
  const seed = st.items.find((s) => s.query)?.query ?? '';

  return (
    <aside className="sb-browser sb-sources" aria-label="资料架">
      <header className="sb-browser-head">
        <span className="sb-browser-badge">{st.live ? 'AI 在看' : '资料'}</span>
        <span className="sb-browser-title" title={active.url}>
          {active.title}
        </span>
        <span className="sb-browser-actions">
          {/* 存为资料：学习者在这里已经选中了某一页，就地把它设成本会话资料（DOC-RAG-SPEC §10） */}
          <SaveAsDocButton key={active.url} sessionId={st.sessionId} item={active} />
          <button className="sb-browser-btn" onClick={() => openVideoRoute(st.sessionId, seed)} title="去 B站 / 抖音找这个知识点的讲解视频">
            找视频
          </button>
          <button className="sb-browser-btn" onClick={() => window.open(active.url, '_blank', 'noopener,noreferrer')} title="在新标签页打开原网页">
            原网页
          </button>
          <button className="sb-browser-btn sb-browser-close" onClick={closeSources} title="关闭资料架">
            ×
          </button>
        </span>
      </header>
      <nav className="src-tabs" aria-label="资料列表">
        {ordered.map((s, k) => (
          <span key={s.n} className={`src-tab-wrap${s.n === active.n ? ' active' : ''}`}>
            <button
              type="button"
              className={`src-tab${s.n === active.n ? ' active' : ''}${s.origin === 'pick' ? ' pick' : ''}`}
              aria-current={s.n === active.n ? 'true' : undefined}
              title={`${k + 1 <= 9 ? `Alt+${k + 1} · ` : ''}[${s.n}] ${s.title}\n${s.url}${s.why ? `\n★ ${s.why}` : ''}`}
              onClick={() => selectSource(s.n)}
            >
              <span className="src-tab-n">{s.n}</span>
              <span className={`src-tab-kind kind-${s.kind}`}>{KIND_GLYPH[s.kind]}</span>
              <span className="src-tab-site">{s.site}</span>
              {s.origin === 'pick' && <span className="src-tab-star" aria-label="AI 精选">★</span>}
              {st.readingN === s.n && <span className="src-tab-reading">在读</span>}
            </button>
            <button type="button" className="src-tab-x" aria-label={`去掉资料 ${s.n}：${s.title}`} title="从架上去掉这条" onClick={() => removeSource(s.n)}>
              ×
            </button>
          </span>
        ))}
      </nav>
      <div className={`sb-browser-note src-note${active.origin === 'pick' ? ' pick' : ''}`} title={note}>
        <span>{note}</span>
      </div>
      <SourceFrame sessionId={st.sessionId} item={active} />
      <footer className="src-foot">
        <span>
          {ordered.findIndex((s) => s.n === active.n) + 1} / {ordered.length}
        </span>
        <span className="src-foot-keys">
          <kbd>[</kbd>
          <kbd>]</kbd> 切换 · <kbd>Alt</kbd>+<kbd>1–9</kbd> 直达
        </span>
      </footer>
    </aside>
  );
}
