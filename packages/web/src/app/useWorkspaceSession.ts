import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopApi } from '../features/desktop/desktop-api';

/** Only the companion restores its selection; the main window keeps its existing start screen.
 * Store on the local server, not by origin: a changed loopback port must not lose the selection.
 * Explicit navigation wins over a late restore; serialized saves cannot finish out of order.
 */
export function useWorkspaceSession(persistent: boolean) {
  const [currentId, updateId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(persistent);
  const version = useRef(0);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    if (!persistent) return;
    let alive = true;
    const initial = version.current;
    void desktopApi.workspace().then(state => {
      if (alive && version.current === initial) updateId(state.sessionId);
    }).catch(() => { /* A missing/older desktop endpoint must not block the app. */ })
      .finally(() => { if (alive) setRestoring(false); });
    return () => { alive = false; };
  }, [persistent]);
  const setCurrentId = useCallback((id: string | null) => {
    version.current++;
    updateId(id); setRestoring(false);
    if (persistent) writes.current = writes.current.catch(() => undefined)
      .then(() => desktopApi.saveWorkspace(id)).then(() => undefined).catch(() => undefined);
  }, [persistent]);
  return { currentId, setCurrentId, restoring };
}
