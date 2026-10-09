import { useEffect, useId, useRef } from 'react';
import { readNarrow, useNarrow } from './use-narrow';

const EVENT = 'sb:mobile-panel';

/** Explicit mobile tools share one foreground surface; closing never resolves a pending action. */
export function useMobilePanel(open: boolean, close: () => void): void {
  const narrow = useNarrow();
  const id = useId();
  const state = useRef({ open, close });
  state.current = { open, close };
  useEffect(() => {
    const onOpen = (event: Event) => {
      if (readNarrow() && state.current.open && (event as CustomEvent<string>).detail !== id) state.current.close();
    };
    window.addEventListener(EVENT, onOpen);
    return () => window.removeEventListener(EVENT, onOpen);
  }, [id]);
  useEffect(() => {
    if (open && narrow) window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
  }, [open, id, narrow]);
}
