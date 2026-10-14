import { useSyncExternalStore } from 'react';
import { closePreview } from '../../lib/preview-store';
import { closeSources } from '../../lib/sources-store';
import { closeVideoRoute } from '../../lib/video-route-store';
let state = { open: false, sessionId: '' };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
export function openDesktopReader(sessionId: string): void {
  closePreview(); closeSources(); closeVideoRoute();
  state = { open: true, sessionId }; emit();
}
export function closeDesktopReader(): void { state = { ...state, open: false }; emit(); }
export function useDesktopReader() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state, () => state);
}

export const OPEN_DESKTOP_READER = "sb-desktop:open-reader";
export function requestDesktopReader(): void { window.dispatchEvent(new Event(OPEN_DESKTOP_READER)); }
