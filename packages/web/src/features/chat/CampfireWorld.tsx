import { useRef } from 'react';
import { useCampfireParallax } from './useCampfireParallax';
import { StudyPortalLink, type StudyPortalControls } from './StudyPortalLink';
import './campfire-world.css';
export type { StudyPortalControls } from './StudyPortalLink';

/** The two landmarks are real learning entrances; scenery never changes reading width. */
export function CampfireWorld({ onEnter, travelling }: StudyPortalControls) {
  const ref = useRef<HTMLDivElement>(null);
  useCampfireParallax(ref);
  return <div ref={ref} className={`campfire-world${travelling ? ` is-going-${travelling}` : ''}`}>
    <div className="cw-sky" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /></div>
    <div className="cw-horizon" aria-hidden="true">
      <svg viewBox="0 0 1000 200" preserveAspectRatio="none" focusable="false" shapeRendering="crispEdges">
        <path className="cw-far" d="M0 200V120h30v-20h30V72h25v-24h30v38h25v24h30v38h38v-28h35v-20h20v38h40v42h400v-20h30v-22h20v-36h30V72h25v-28h24v42h28v24h32v-12h28v36h27v66z" />
        <path className="cw-near" d="M0 200v-36h42v-18h28v20h52v14h90v-10h70v30h430v-30h60v-12h42v-24h30v36h56v-18h30v26h70v22z" />
      </svg>
    </div>
    <div className="cw-path" aria-hidden="true" />
    <StudyPortalLink destination="continent" onEnter={onEnter} travelling={travelling} />
    <StudyPortalLink destination="terms" onEnter={onEnter} travelling={travelling} />
    <div className="cw-arrival" aria-hidden="true"><span /><span /><span /><span /></div>
  </div>;
}
