import { useLayoutEffect, useRef } from 'react';
import { STUDY_PORTALS } from '../features/chat/StudyPortalLink';
import type { PortalTravel } from './useStudyPortal';
import './study-portal-travel.css';

export function StudyPortalTravel({ travel, onFinish }: { travel: PortalTravel | null; onFinish: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!travel || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    ref.current.style.setProperty('--travel-x', `${Math.round(Math.max(0, Math.min(box.width, travel.origin.x - box.x)))}px`);
    ref.current.style.setProperty('--travel-y', `${Math.round(Math.max(0, Math.min(box.height, travel.origin.y - box.y)))}px`);
  }, [travel]);
  if (!travel) return null;
  return <div ref={ref} className={`study-portal-travel is-${travel.destination}`} role="status" aria-live="polite"
    onAnimationEnd={event => { if (event.target === event.currentTarget) onFinish(); }}>
    <div className="study-travel-seal" aria-hidden="true"><i /><i /><i /><i /></div>
    <span className="study-travel-title">{STUDY_PORTALS[travel.destination].title}</span>
    <span className="study-travel-sub">正在进入{STUDY_PORTALS[travel.destination].destination}…</span>
  </div>;
}
