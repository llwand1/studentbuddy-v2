import { MAX_IMAGE_DATAURL_CHARS } from '@sb/shared';
import { onHostMessage, postToHost } from '../float/float-view';

export const HOST_SCREEN_CAPTURE = 'sb-desktop:capture';
export const HOST_QUICK_INPUT = 'sb-float:quick-input';
export const CAPTURE_RESULT = 'sb-desktop:capture-result:';
export const OPEN_COMPOSER = 'sb-desktop:open-composer';
export interface DesktopCapture { id: string; dataUrl: string; name: string; width: number; height: number; }
export interface DesktopInputState { capture: DesktopCapture | null; focus: boolean; error: string; }
let state: DesktopInputState = { capture: null, focus: false, error: '' };
const listeners = new Set<(value: DesktopInputState) => void>();
let stopHost: (() => void) | undefined;
function publish(): void { const current = state; for (const notify of listeners) notify(current); }
export function parseDesktopCapture(raw: string): DesktopCapture | null {
  if (raw.length > MAX_IMAGE_DATAURL_CHARS + 1024) return null;
  try {
    const v = JSON.parse(raw) as Partial<DesktopCapture>;
    if (typeof v.id !== 'string' || !/^[\w-]{1,80}$/.test(v.id) || typeof v.name !== 'string' || v.name.length > 120 ||
      typeof v.dataUrl !== 'string' || v.dataUrl.length > MAX_IMAGE_DATAURL_CHARS || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(v.dataUrl) ||
      !Number.isInteger(v.width) || !Number.isInteger(v.height) || (v.width ?? 0) < 1 || (v.height ?? 0) < 1 || (v.width ?? 0) > 10000 || (v.height ?? 0) > 10000) return null;
    return v as DesktopCapture;
  } catch { return null; }
}
/** Central inbox is shared by the always-mounted float shell and lazily-mounted App. */
export function receiveDesktopInput(message: string): void {
  if (message === HOST_QUICK_INPUT) state = { ...state, focus: true, error: '' };
  else if (message.startsWith(CAPTURE_RESULT)) {
    const capture = parseDesktopCapture(message.slice(CAPTURE_RESULT.length));
    state = capture ? { capture, focus: true, error: '' } : { capture: null, focus: false, error: '截图数据无效或过大，请重新框选。' };
  } else if (message.startsWith('sb-desktop:capture-error:')) state = { capture: null, focus: false, error: message.slice('sb-desktop:capture-error:'.length, 600) };
  else return; // Cancellation leaves existing text/images untouched.
  publish();
}
export function watchDesktopInput(notify: (value: DesktopInputState) => void): () => void {
  if (!stopHost) stopHost = onHostMessage(receiveDesktopInput);
  listeners.add(notify); notify(state);
  return () => { listeners.delete(notify); if (!listeners.size) { stopHost?.(); stopHost = undefined; } };
}
export function consumeDesktopFocus(): void { state = { ...state, focus: false }; }
export function discardDesktopCapture(): void { state = { capture: null, focus: false, error: '' }; publish(); }
export function requestDesktopCapture(): void { discardDesktopCapture(); postToHost(HOST_SCREEN_CAPTURE); }
