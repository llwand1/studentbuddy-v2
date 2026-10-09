import { CardsIcon, GraphIcon } from '../../components/icons';
const library = new URL('../../assets/study-portals/magic-library.svg', import.meta.url).href;
const ruins = new URL('../../assets/study-portals/ruin-entrance.svg', import.meta.url).href;

export type StudyDestination = 'terms' | 'continent';
export type PortalOrigin = { x: number; y: number };
export type PortalEnter = (destination: StudyDestination, origin: PortalOrigin) => void;
/** Shared entrance controls for the full scenery and compact welcome navigation. */
export type StudyPortalControls = {
  onEnter?: PortalEnter;
  travelling?: StudyDestination | null;
};
export const STUDY_PORTALS = {
  terms: { title: '魔法图书馆', destination: '词条库', art: library, Icon: CardsIcon },
  continent: { title: '遗迹入口', destination: '知识大陆', art: ruins, Icon: GraphIcon },
};

export function StudyPortalLink({ destination, onEnter, travelling, compact = false }: {
  destination: StudyDestination;
  onEnter?: PortalEnter;
  travelling?: StudyDestination | null;
  compact?: boolean;
}) {
  const portal = STUDY_PORTALS[destination];
  return <button type="button" className={compact ? 'cw-shortcut' : `cw-waypoint cw-${destination === 'terms' ? 'right' : 'left'}`}
    aria-label={`${portal.title}，前往${portal.destination}`} disabled={!onEnter || !!travelling}
    onClick={event => {
      const box = event.currentTarget.getBoundingClientRect();
      onEnter?.(destination, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    }}>
    {compact ? <portal.Icon /> : <span className="cw-landmark" aria-hidden="true">
      <img src={portal.art} alt="" width="192" height="288" decoding="async" />
      <i className="cw-door-aura" /><i className="cw-door-spark" />
    </span>}
    <span className="cw-waypoint-name">{portal.title}</span>
    <span className="cw-waypoint-action">{travelling === destination ? '正在进入…' : `进入${portal.destination} →`}</span>
  </button>;
}

export function CampfireShortcuts(props: StudyPortalControls) {
  if (!props.onEnter) return null;
  return <nav className="cw-shortcuts" aria-label="营地学习入口">
    <StudyPortalLink destination="terms" compact {...props} />
    <StudyPortalLink destination="continent" compact {...props} />
  </nav>;
}
