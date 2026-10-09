import { useCallback, useEffect, useState } from 'react';

export const CAMPFIRE_HANDOFF_MS = 680;
type Turn = { target: string | null; heroKey: string; phase: 'pending' | 'leaving' };
/** A visual handoff follows the accepted first send; it never schedules a send or a model call. */
export function useCampfireHandoff({ sessionId, empty, historyReady, starting, busy, failed }: {
  sessionId: string | null; empty: boolean; historyReady: boolean; starting: boolean; busy: boolean; failed: boolean;
}) {
  const [turn, setTurn] = useState<Turn | null>(null);
  const matches = turn !== null && (turn.target === null || turn.target === sessionId);
  const active = matches && !failed ? turn : null;
  const leaving = !!active && (active.phase === 'leaving' || (historyReady && !empty && busy));
  const begin = useCallback(() => {
    if (!empty || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    setTurn({ target: sessionId, heroKey: sessionId ?? 'campfire', phase: 'pending' });
  }, [empty, sessionId]);

  useEffect(() => {
    if (!turn) return;
    if (!matches || failed) { setTurn(null); return; }
    if (turn.phase === 'pending') {
      if (historyReady && !empty && busy) {
        setTurn({ ...turn, target: sessionId, phase: 'leaving' });
      } else if (!starting && !busy) {
        setTurn(null);
      } else if (turn.target === null && sessionId !== null) {
        setTurn({ ...turn, target: sessionId });
      }
      return;
    }
  }, [turn, matches, failed, historyReady, empty, busy, starting, sessionId]);

  useEffect(() => {
    if (turn?.phase !== 'leaving') return;
    const timer = window.setTimeout(() => setTurn(null), CAMPFIRE_HANDOFF_MS);
    return () => window.clearTimeout(timer);
  }, [turn?.phase, turn?.target]);

  useEffect(() => {
    if (!turn) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const stop = () => { if (media?.matches) setTurn(null); };
    stop(); media?.addEventListener?.('change', stop);
    return () => media?.removeEventListener?.('change', stop);
  }, [turn]);
  return { begin, keep: !!active, waiting: !!active && !leaving, leaving, heroKey: active?.heroKey ?? sessionId ?? 'campfire' };
}
