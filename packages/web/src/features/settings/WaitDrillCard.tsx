/**
 * WaitDrillCard — 设置页「等待时刷词」卡（契约 `docs/WAIT-DRILL-SPEC.md` §6）。
 *
 * 两个本机开关（自动弹 / 音乐与音效）+ 一个「现在试一局」入口。
 * ★ 偏好存本机 `localStorage`（`drill-prefs.ts`）而非服务端：要不要弹、要不要出声是这台设备的事。
 * ★ 点选即存（同 QuizImageCard / ToolsCard）：两取值之间的独立保存按钮只会制造「改了没存」。
 * ★ 试一局走 `requestDrillOpen()`（window 事件）：常驻在 App 壳层的 `WaitDrill` 收到就开，
 *   不必把弹窗再挂一份到设置页。
 */
import { useState } from 'react';
import { DRILL_OPEN_DELAY_MS } from '@sb/shared';
import { loadDrillPrefs, requestDrillOpen, saveDrillPrefs } from '../drill/drill-prefs';
import './settings.css';

export function WaitDrillCard() {
  const [prefs, setPrefs] = useState(loadDrillPrefs);
  const secs = Math.round(DRILL_OPEN_DELAY_MS / 1000);
  const toggle = (key: 'enabled' | 'sound') => setPrefs(saveDrillPrefs({ [key]: !prefs[key] }));
  return (
    <section className="settings-sec">
      <h3>等待时刷词</h3>
      <p className="settings-hint">
        发出问题后 AI 还在想，{secs} 秒没回完就弹一张词卡让你刷（百词斩式四选一 / 释义选词 / 拼写）；
        回复到了答完这张自动切回。到期词条答对算一次复习打卡，其余只记战绩。
      </p>
      <div className="quiz-mix-presets">
        <button
          type="button"
          className={prefs.enabled ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
          aria-pressed={prefs.enabled}
          onClick={() => toggle('enabled')}
        >
          等回复时自动弹：{prefs.enabled ? '开' : '关'}
        </button>
        <button
          type="button"
          className={prefs.sound ? 'quiz-mix-chip active' : 'quiz-mix-chip'}
          aria-pressed={prefs.sound}
          onClick={() => toggle('sound')}
        >
          音乐与音效：{prefs.sound ? '开' : '关'}
        </button>
        <button type="button" className="quiz-mix-chip" onClick={requestDrillOpen}>
          现在试一局
        </button>
      </div>
      <p className="settings-hint">
        关掉自动弹后，等待气泡旁仍保留「刷词」入口可手动打开；弹窗里按 ✕ 或 Esc 关掉，本轮不再弹。
      </p>
    </section>
  );
}
