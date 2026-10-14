/**
 * Desktop companion, full app, independent quiz and settings share one host window.
 * The 32px sprite and particle frame also define the native transparent clip region.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { App } from '../../app/App';
import { HOST_COLLAPSE, HOST_DRAG, HOST_EXPAND, onHostMessage, postToHost } from './float-view';
import './float.css';
import { useFloatStudy } from './useFloatStudy';
import { FloatQuiz } from './FloatQuiz';
import { FloatStudySettings } from './FloatStudySettings';
import { FloatCompanion } from './FloatCompanion';
import { companionMood, type CompanionMood } from './companion-view';
import '../desktop/desktop-study.css';
import { watchDesktopInput } from '../desktop/desktop-input';
import { RESTORE_LATEST } from '../chat/useScrollAnchor';
import { CompanionInvitation, HOST_CHALLENGE, HOST_SNOOZE, HOST_INVITE } from './CompanionInvitation';

export function FloatApp() {
  const [mode, setMode] = useState<'ball' | 'screen' | 'quiz' | 'settings'>(() => {
    const saved = new URLSearchParams(location.hash.split('?')[1]).get('mode');
    return saved === 'screen' || saved === 'settings' ? saved : 'ball';
  });
  const [screenOpened, setScreenOpened] = useState(mode === 'screen');
  const [actionError, setActionError] = useState('');
  const [reaction, setReaction] = useState<CompanionMood | null>(null);
  const verdict = useRef<boolean | null>(null);
  const study = useFloatStudy(mode === 'ball');
  useEffect(() => {
    document.documentElement.dataset.float = mode;
    return () => { delete document.documentElement.dataset.float; };
  }, [mode]);
  useEffect(() => {
    if (!reaction) return;
    const timer = window.setTimeout(() => setReaction(null), 4000);
    return () => window.clearTimeout(timer);
  }, [reaction]);
  const expand = useCallback(() => { postToHost(HOST_EXPAND); setScreenOpened(true); setMode('screen'); }, []);
  const collapse = useCallback(() => { postToHost(HOST_COLLAPSE); setMode('ball'); }, []);
  const settings = useCallback(() => { postToHost('sb-float:settings'); setMode('settings'); }, []);
  useEffect(() => watchDesktopInput(value => { if (value.focus || value.capture || value.error) expand(); }), [expand]);
  useEffect(() => onHostMessage(message => { if (message === 'sb-float:open-settings') settings(); }), [settings]);
  const challenge = useCallback(() => {
    if (mode !== 'ball' || !study.state?.awaiting || !study.state.question) return;
    postToHost('sb-float:quiz'); setMode('quiz');
  }, [mode,study.state?.awaiting,study.state?.question]);
  const finish = async (action: 'done' | 'skip' | 'snooze') => {
    setActionError(''); await study.dismiss(action);
    if (action === 'done' && verdict.current !== null) setReaction(verdict.current ? 'celebrate' : 'encourage');
    verdict.current = null; collapse();
  };
  const snooze = () => {void finish('snooze').catch(e=>{
    setActionError(e instanceof Error?e.message:'延后失败，请重试');postToHost(HOST_INVITE+'reset');
  });};
  useEffect(()=>onHostMessage(message=>{
    if (mode !== 'ball' || !study.state?.awaiting || !study.state.question) return;
    if (message===HOST_CHALLENGE+study.state.question.id) challenge();
    else if (message===HOST_SNOOZE+study.state.question.id) snooze();
  }));
  return <>
    {screenOpened && <FloatScreen hidden={mode !== 'screen'} onCollapse={collapse} />}
    {(mode === 'settings' || mode === 'quiz') && <div className="sb-float-screen desktop-float">
    <div className="sb-float-bar" onPointerDown={e => { if (e.button === 0 && !(e.target as HTMLElement).closest('button')) postToHost(HOST_DRAG); }}>
      <span className="sb-float-bar-name">{mode === 'quiz' ? 'StudentBuddy · 定时练习' : 'StudentBuddy · 桌面学习'}</span>
      <button type="button" className="sb-float-collapse" aria-label={mode === 'quiz' ? '两分钟后再练' : '收成吉祥物'} onClick={() => {
        if (mode === 'quiz') void finish('snooze').catch(e => setActionError(e instanceof Error ? e.message : '收起失败，请重试')); else collapse();
      }}>—</button>
    </div>
    {(study.error || actionError) && <p role="alert" className="desktop-error">{study.error || actionError}</p>}
    {mode === 'settings' ? <FloatStudySettings state={study.state} onSave={study.configure} />
      : study.state?.question && <FloatQuiz key={study.state.question.id} opener={study.state.question} onFinish={finish} onVerdict={correct => { verdict.current = correct; }} />}
    </div>}
    {mode === 'ball' && <><FloatCompanion mood={reaction ?? companionMood(study.state, study.browser, study.error)} onOpen={study.state?.awaiting?challenge:expand} onSettings={settings} />
      {study.state?.awaiting&&study.state.question&&<CompanionInvitation opener={study.state.question} onChallenge={challenge} onSnooze={snooze}/>}</>}
  </>;
}

/** Expanded app uses the existing responsive interface and preserves native dragging. */
function FloatScreen({ hidden, onCollapse }: { hidden: boolean; onCollapse: () => void }) {
  useEffect(() => { if (!hidden) window.dispatchEvent(new Event(RESTORE_LATEST)); }, [hidden]);
  const onDragDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    postToHost(HOST_DRAG);
  };
  return <div className="sb-float-screen" hidden={hidden}>
    <div className="sb-float-bar" onPointerDown={onDragDown}>
      <span className="sb-float-drag-grip" aria-hidden="true" />
      <button type="button" className="sb-float-collapse" title="收成吉祥物" aria-label="收成吉祥物" onClick={onCollapse}>—</button>
    </div><div className="sb-float-app"><App desktopFloat /></div>
  </div>;
}
