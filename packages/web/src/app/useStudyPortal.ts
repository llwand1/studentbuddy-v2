import { useCallback, useEffect, useRef, useState } from 'react';
import type { View } from './nav';
import type { PortalEnter, PortalOrigin, StudyDestination } from '../features/chat/StudyPortalLink';

export type PortalTravel = { destination: StudyDestination; origin: PortalOrigin };
/** Route changes under a closed iris; ordinary navigation cancels pending travel. */
export function useStudyPortal(applyView: (view: View) => void) {
  const [travel, setTravel] = useState<PortalTravel | null>(null);
  const job = useRef<{ travel: PortalTravel; swapped: boolean } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const frame = useRef(0);
  const clear = useCallback(() => {
    timers.current.forEach(clearTimeout); timers.current = [];
    window.cancelAnimationFrame(frame.current); frame.current = 0;
  }, []);
  const cancel = useCallback(() => { clear(); job.current = null; setTravel(null); }, [clear]);
  const focus = useCallback((destination: StudyDestination) => {
    frame.current = window.requestAnimationFrame(() => {
      frame.current = 0;
      const scene = document.querySelector(`.sb-scene[data-scene="${destination}"]`);
      const heading = scene?.querySelector<HTMLElement>(':scope > :not([hidden]) h1, :scope > :not([hidden]) h2');
      if (!heading) return;
      const old = heading.getAttribute('tabindex');
      heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true });
      heading.addEventListener('blur', () => { if (old === null) heading.removeAttribute('tabindex'); else heading.setAttribute('tabindex', old); }, { once: true });
    });
  }, []);
  const finish = useCallback(() => {
    const current = job.current;
    if (!current) return;
    clear(); job.current = null;
    if (!current.swapped) applyView(current.travel.destination);
    setTravel(null); focus(current.travel.destination);
  }, [applyView, clear, focus]);
  const navigate = useCallback((view: View) => { cancel(); applyView(view); }, [cancel, applyView]);
  const enter: PortalEnter = useCallback((destination, origin) => {
    if (job.current) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      applyView(destination); focus(destination); return;
    }
    const next = { travel: { destination, origin }, swapped: false };
    job.current = next; setTravel(next.travel);
    timers.current = [setTimeout(() => {
      if (job.current !== next) return;
      next.swapped = true; applyView(destination);
    }, 340), setTimeout(finish, 860)];
  }, [applyView, finish, focus]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => { if (media?.matches) finish(); };
    media?.addEventListener?.('change', change);
    return () => { media?.removeEventListener?.('change', change); clear(); job.current = null; };
  }, [clear, finish]);
  return { travel, enter, navigate, cancel, finish };
}
