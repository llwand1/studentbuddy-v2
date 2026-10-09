import { useEffect, useState } from 'react';
import { readNarrow } from '../lib/use-narrow';

const KEY = 'sb:reading:sidebar-collapsed';
function loadCollapsed(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** Focus is temporary; leaving it restores the user's navigation preference. */
export function useReadingLayout() {
  // Mobile keyboards can shrink VisualViewport without changing 100dvh.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const sync = () => {
      if (!readNarrow() || viewport.scale !== 1) { root.style.removeProperty('--sb-visual-height'); return; }
      root.style.setProperty('--sb-visual-height', `${Math.round(Math.min(window.innerHeight, viewport.height + viewport.offsetTop))}px`);
    };
    sync();
    viewport.addEventListener('resize', sync); viewport.addEventListener('scroll', sync); window.addEventListener('resize', sync);
    return () => {
      viewport.removeEventListener('resize', sync); viewport.removeEventListener('scroll', sync); window.removeEventListener('resize', sync);
      root.style.removeProperty('--sb-visual-height');
    };
  }, []);
  const [preferredCollapsed, setPreferredCollapsed] = useState(loadCollapsed);
  const [focused, setFocused] = useState(false);
  const toggleSidebar = () => {
    const next = focused ? false : !preferredCollapsed;
    setFocused(false);
    setPreferredCollapsed(next);
    try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* Private browsing still supports the current layout. */ }
  };
  return { collapsed: focused || preferredCollapsed, focused, toggleSidebar, toggleFocus: () => setFocused((v) => !v) };
}
