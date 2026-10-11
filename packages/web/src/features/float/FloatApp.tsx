/**
 * FloatApp — 桌面悬浮球的内容（`#/float`，契约 docs/DESKTOP-SPEC.md「桌面悬浮球」）。
 *
 * ★ 球、展开应用、独立题卡、设置四种形态，同一个窗口（尺寸由宿主改）：
 *   · **球态**：只有吉祥物本体（沿用 `Mascot` 的 16×16 点阵与它自带的眨眼动画）。宿主按吉祥物外形
 *     把球窗裁成它的轮廓，页面整页透明 ⇒ 桌面上看见的就是一只活的吉祥物，没有窗框、没有底板。
 *   · **展开态**：一条可拖的薄条 + **现有 App 本体**（`<App/>`）。窗口开到手机宽度（宿主做），
 *     App 自己按 700px 断点走移动端布局 —— 问问题、等 2 秒弹刷词、出题卡片、词条/复习页全都在，
 *     **不新做第二套前端**（刻意的：小屏与主窗口必须是同一个 App，否则以后每改一处都要跟一次）。
 * ★ 定时题卡不挂载 App；宿主按时唤醒小球页面，在原窗口展示题卡，不导航 URL。
 * ★ 球态**不显示任何数字/角标**：球窗是按吉祥物轮廓裁的，轮廓外的像素会被裁掉。
 */
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { App } from '../../app/App';
import { Mascot } from '../chat/Mascot';
import {
  HOST_COLLAPSE,
  HOST_DRAG,
  HOST_EXPAND,
  HOST_TAP,
  hasHost,
  onHostMessage,
  postToHost,
} from './float-view';
import './float.css';
import { useFloatStudy } from './useFloatStudy';
import { FloatQuiz } from './FloatQuiz';
import { FloatStudySettings } from './FloatStudySettings';
import '../desktop/desktop-study.css';

export function FloatApp() {
  const [mode, setMode] = useState<'ball' | 'screen' | 'quiz' | 'settings'>('ball');
  const [actionError, setActionError] = useState('');
  const study = useFloatStudy(mode === 'ball');

  /**
   * 透明底只在球态要。★ 展开态必须整页不透明，否则 App 会「漏」出桌面（窗口这时是完整矩形）。
   */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.float = mode;
    return () => {
      delete root.dataset.float;
    };
  }, [mode]);

  const expand = useCallback(() => {
    postToHost(HOST_EXPAND);
    setMode('screen');
  }, []);
  const collapse = useCallback(() => {
    postToHost(HOST_COLLAPSE);
    setMode('ball');
  }, []);
  const settings = useCallback(() => { postToHost('sb-float:settings'); setMode('settings'); }, []);
  useEffect(() => onHostMessage(message => { if (message === 'sb-float:open-settings') settings(); }), [settings]);
  useEffect(() => {
    if (mode === 'ball' && study.state?.awaiting && study.state.question) {
      postToHost('sb-float:quiz'); setMode('quiz');
    }
  }, [mode, study.state]);
  const finish = async (action: 'done' | 'skip' | 'snooze') => { setActionError(''); await study.dismiss(action); collapse(); };

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
      : study.state?.question && <FloatQuiz key={study.state.question.id} opener={study.state.question} onFinish={finish} />}
  </div>;
  return <FloatBall onOpen={expand} onSettings={settings} />;
}

/** 球态：只有吉祥物本身（宿主已按它的轮廓裁好窗口） */
function FloatBall({ onOpen, onSettings }: { onOpen: () => void; onSettings: () => void }) {
  /**
   * 「点一下＝展开」与「拖一把＝挪位置」的区分**在宿主做**：按下就请宿主进入系统移动循环，
   * 宿主跑完发现窗口没挪窝就回一条 `HOST_TAP`，我们才展开。
   * ★ 为什么不在网页判位移：WebView2 按住不放时不派发 pointermove（实机实测），网页侧看不到位移。
   */
  useEffect(() => onHostMessage((message) => {
    if (message === HOST_TAP) onOpen();
  }), [onOpen]);

  return (
    <button
      type="button"
      className="sb-ball"
      title="点击打开 · 拖动换位置 · 右键设置定时出题与网页共读"
      aria-label="打开 StudentBuddy"
      onContextMenu={e => { e.preventDefault(); onSettings(); }}
      onPointerDown={(e) => {
        if (e.button === 0) postToHost(HOST_DRAG);
      }}
      // 普通浏览器里没有宿主、也就没有那套判定：退回「点一下直接展开」，功能不丢
      onClick={() => {
        if (!hasHost()) onOpen();
      }}
    >
      <Mascot />
    </button>
  );
}

/** 展开态：薄条（拖动 + 收起）+ 现有 App 本体 */
function FloatScreen({ onCollapse }: { onCollapse: () => void }) {
  /** 按住薄条即请宿主进入系统原生拖动循环（点在按钮上不算拖动） */
  const onDragDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    postToHost(HOST_DRAG);
  };
  return (
    <div className="sb-float-screen">
      <div className="sb-float-bar" onPointerDown={onDragDown}>
        <span className="sb-float-bar-name">StudentBuddy</span>
        <button
          type="button"
          className="sb-float-collapse"
          title="收成吉祥物"
          aria-label="收成吉祥物"
          onClick={onCollapse}
        >
          —
        </button>
      </div>
      <div className="sb-float-app">
        <App />
      </div>
    </div>
  );
}
