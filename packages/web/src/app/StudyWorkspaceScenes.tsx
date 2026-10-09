import type { Session } from '@sb/shared';
import type { View } from './nav';
import type { PortalEnter, StudyDestination } from '../features/chat/StudyPortalLink';
import { SceneTransition } from '../components/SceneTransition';
import { TermIndexProvider } from '../features/chat/term-index';
import { ChatView } from '../features/chat/ChatView';
import { TermsLibraryView } from '../features/terms/TermsLibraryView';
import { ContinentPage } from '../features/continent/ContinentPage';
import { SettingsView } from '../features/settings/SettingsView';

export function StudyWorkspaceScenes({ view, currentId, sessions, termsKeyword, travelling, onEnter,
  onNewSession, onRoundDone, onBusyChange, onOpenTerms, onFollowUp, onGoContinent }: {
  view: View;
  currentId: string | null;
  sessions: Session[];
  termsKeyword: string;
  travelling: StudyDestination | null;
  onEnter: PortalEnter;
  onNewSession: () => void;
  onRoundDone: () => void;
  onBusyChange: (busy: boolean, sessionId: string | null) => void;
  onOpenTerms: (keyword: string) => void;
  onFollowUp: (term: string, question?: string, fromSessionId?: string) => Promise<void>;
  onGoContinent: () => void;
}) {
  return <SceneTransition scene={view} persistent quiet={!!travelling}>
    {/* Kept mounted: returning from a landmark restores the same question, answer and draft. */}
    <div className="sb-chat-persist" hidden={view !== 'chat'}>
      <TermIndexProvider onOpenTerms={onOpenTerms} onFollowUp={onFollowUp}>
        <ChatView sessionId={currentId} sessionTitle={sessions.find(s => s.id === currentId)?.title}
          onNewSession={onNewSession} onRoundDone={onRoundDone} onBusyChange={onBusyChange}
          onEnter={onEnter} travelling={travelling} />
      </TermIndexProvider>
    </div>
    {view === 'terms' && <TermsLibraryView key={termsKeyword} initialKeyword={termsKeyword} onGoContinent={onGoContinent} />}
    {view === 'continent' && <ContinentPage />}
    {view === 'settings' && <SettingsView />}
  </SceneTransition>;
}
