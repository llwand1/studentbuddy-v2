import { useSyncExternalStore, type ReactNode } from 'react';
import { DocIcon, SidebarIcon, ReadingIcon } from '../components/icons';
import { closeSources, reopenSources, useSources } from '../lib/sources-store';
import { closePreview, getPreview, subscribePreview } from '../lib/preview-store';
import { closeVideoRoute, useVideoRoute } from '../lib/video-route-store';
import { useLandingLang } from './landing-lang';
import { SHELL } from './shell-copy';
import type { useReadingLayout } from './useReadingLayout';

/** Controls occupy their own row, outside the text and source reading surfaces. */
export function ReadingToolbar({ layout, sessionId, title, children }: {
  layout: ReturnType<typeof useReadingLayout>;
  sessionId: string | null;
  title?: string;
  children: ReactNode;
}) {
  const { lang } = useLandingLang();
  const sources = useSources();
  const preview = useSyncExternalStore(subscribePreview, getPreview, getPreview);
  const video = useVideoRoute();
  const available = sources.sessionId === sessionId && sources.items.length > 0;
  const showing = sources.open && !preview && !video.open;
  return (
    <header className="reading-toolbar" aria-label={SHELL.readingTools[lang]}>
      <div className="reading-toolbar-start">
        <button className="reading-tool reading-nav-toggle" type="button" aria-controls="sb-sidebar-content"
          aria-expanded={!layout.collapsed} onClick={layout.toggleSidebar}>
          <SidebarIcon aria-hidden="true" /> {layout.collapsed ? SHELL.sidebarOpen[lang] : SHELL.sidebarClose[lang]}
        </button>
        {children}
      </div>
      {layout.focused && title && <span className="reading-toolbar-title" title={title}>{title}</span>}
      <div className="reading-toolbar-actions">
        {available && <button className="reading-tool reading-sources-entry" type="button" aria-expanded={showing}
          onClick={() => {
            closePreview(); closeVideoRoute();
            if (showing) closeSources(); else reopenSources();
          }}>
          <DocIcon aria-hidden="true" /> {SHELL.sources[lang]} <span className="reading-count">{sources.items.length}</span>
        </button>}
        <button className="reading-tool reading-focus" type="button" aria-pressed={layout.focused} onClick={layout.toggleFocus}
          aria-label={layout.focused ? SHELL.focusExit[lang] : SHELL.focusEnter[lang]} title={layout.focused ? SHELL.focusExit[lang] : SHELL.focusEnter[lang]}>
          <ReadingIcon aria-hidden="true" /> <span>{layout.focused ? SHELL.focusExit[lang] : SHELL.focusEnter[lang]}</span>
        </button>
      </div>
    </header>
  );
}
