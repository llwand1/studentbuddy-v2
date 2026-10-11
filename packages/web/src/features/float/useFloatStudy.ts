import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopStudyState, DesktopStudySettings } from '@sb/shared';
import { desktopApi } from '../desktop/desktop-api';
import { hasHost, onHostMessage } from './float-view';
export function useFloatStudy(eligible: boolean) {
  const [state, setState] = useState<DesktopStudyState | null>(null);
  const [error, setError] = useState('');
  const mutation = useRef(0);
  const eligibleRef = useRef(eligible); eligibleRef.current = eligible;
  useEffect(() => {
    let live = true; let polling = false;
    const tick = () => {
      if (polling) return;
      polling = true;
      const version = mutation.current;
      void desktopApi.tick(eligibleRef.current).then(next => { if (live && version === mutation.current) { setState(next); setError(''); } })
        .catch(() => { if (live) setError('本机服务暂时断开，正在重连'); }).finally(() => { polling = false; });
    };
    tick();
    const off = onHostMessage(message => { if (message === 'sb-float:tick') tick(); });
    const timer = hasHost() ? null : window.setInterval(tick, 2000);
    return () => { live = false; off(); if (timer !== null) window.clearInterval(timer); };
  }, []);
  const configure = useCallback(async (settings: DesktopStudySettings) => { mutation.current++; const next = await desktopApi.settings(settings); setState(next); }, []);
  const dismiss = useCallback(async (action: 'done' | 'skip' | 'snooze') => { mutation.current++; const next = await desktopApi.dismiss(action); setState(next); }, []);
  return { state, error, configure, dismiss };
}
