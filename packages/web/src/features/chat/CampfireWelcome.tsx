import { Welcome } from './Welcome';
import type { StudyPortalControls } from './CampfireWorld';
import './campfire-handoff.css';

export function CampfireWelcome({ frozen, leaving, ...props }: StudyPortalControls & {
  frozen: boolean; leaving: boolean; blocked: boolean; onPick: (text: string) => void; onAsk: () => void;
}) {
  return <div className={`chat-welcome-shell${leaving ? ' is-leaving' : ''}`} aria-hidden={frozen || undefined}
    ref={node => node?.toggleAttribute('inert', frozen)}>
    <Welcome {...props} frozen={frozen} />
  </div>;
}

export function CampfireHandoffTrace() {
  return <div className="chat-handoff-trace" aria-hidden="true">
    <i className="chat-handoff-thread" /><i className="chat-handoff-thread echo" />
    <div className="chat-handoff-motes">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</div>
  </div>;
}
