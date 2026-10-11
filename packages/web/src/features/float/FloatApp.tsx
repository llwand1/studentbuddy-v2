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

export function FloatApp() {
  const [mode, setMode] = useState<'ball' | 'screen' | 'quiz' | 'settings'>('ball');
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
  const expand = useCallback(() => { postToHost(HOST_EXPAND); setMode('screen'); }, []);
  const collapse = useCallback(() => { postToHost(HOST_COLLAPSE); setMode('ball'); }, []);
  const settings = useCallback(() => { postToHost('sb-float:settings'); setMode('settings'); }, []);
  useEffect(() => onHostMessage(message => { if (message === 'sb-float:open-settings') settings(); }), [settings]);
  useEffect(() => {
    if (mode === 'ball' && study.state?.awaiting && study.state.question) {
      postToHost('sb-float:quiz'); setMode('quiz');
    }
  }, [mode, study.state]);
  const finish = async (action: 'done' | 'skip' | 'snooze') => {
    setActionError(''); await study.dismiss(action);
    if (action === 'done' && verdict.current !== null) setReaction(verdict.current ? 'celebrate' : 'encourage');
    verdict.current = null; collapse();
  };
  if (mode === 'screen') return <FloatScreen onCollapse={collapse} />;
  if (mode === 'settings' || mode === 'quiz') return <div className="sb-float-screen desktop-float">
    <div className="sb-float-bar" onPointerDown={e => { if (e.button === 0 && !(e.target as HTMLElement).closest('button')) postToHost(HOST_DRAG); }}>
      <span className="sb-float-bar-name">{mode === 'quiz' ? 'StudentBuddy · 定时练习' : 'StudentBuddy · 桌面学习'}</span>
      <button type="button" className="sb-float-collapse" aria-label={mode === 'quiz' ? '两分钟后再练' : '收成吉祥物'} onClick={() => {
        if (mode === 'quiz') void finish('snooze').catch(e => setActionError(e instanceof Error ? e.message : '收起失败，请重试')); else collapse();
      }}>—</button>
    </div>
    {(study.error || actionError) && <p role="alert" className="desktop-error">{study.error || actionError}</p>}
    {mode === 'settings' ? <FloatStudySettings state={study.state} onSave={study.configure} />
      : study.state?.question && <FloatQuiz key={study.state.question.id} opener={study.state.question} onFinish={finish} onVerdict={correct => { verdict.current = correct; }} />}
  </div>;
  return <FloatCompanion mood={reaction ?? companionMood(study.state, study.browser, study.error)} onOpen={expand} onSettings={settings} />;
}

/** Expanded app uses the existing responsive interface and preserves native dragging. */
function FloatScreen({ onCollapse }: { onCollapse: () => void }) {
  const onDragDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    postToHost(HOST_DRAG);
  };
  return <div className="sb-float-screen">
    <div className="sb-float-bar" onPointerDown={onDragDown}>
      <span className="sb-float-bar-name">StudentBuddy</span>
      <button type="button" className="sb-float-collapse" title="收成吉祥物" aria-label="收成吉祥物" onClick={onCollapse}>—</button>
    </div><div className="sb-float-app"><App /></div>
  </div>;
}
