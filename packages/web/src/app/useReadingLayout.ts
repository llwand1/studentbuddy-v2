import { useState } from 'react';

const KEY = 'sb:reading:sidebar-collapsed';
function loadCollapsed(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

/** Focus is temporary; leaving it restores the user's navigation preference. */
export function useReadingLayout() {
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
