/**
 * SpeechCard — 词条朗读设置卡（音色 / 语速，契约 `shared/src/speech.ts`）。
 *
 * ★ **「改了就存」**（同 AnswerStyleCard / QuizImageCard）：音色是短值，多一步保存按钮
 *   只会多出「改了没存」的困惑。
 * ★ **语速滑条「拖完才存」**：`onChange` 在拖动期间连续触发，逐次 PUT 会把接口打爆；
 *   故拖动只改本地草稿，`onPointerUp` / `onKeyUp` 才落库。
 *   ★ **两处都要挂**：键盘操作滑条（方向键）**不触发 pointerup**，只挂 pointerup 会让
 *   「用方向键调速」永远存不上；只挂 keyup 则鼠标拖完不存。少挂一个就有一半用户存不上。
 * ★ **试听必须反映「还没保存」的选择**：用户调完语速第一反应是点试听，若试听用的是
 *   上一次落库的值，他会以为滑条坏了。故试听前把**屏上当前值**（含草稿）塞进朗读缓存
 *   ——`speakEnglish` 读的正是那份缓存。
 * ★ **不是「配过没有」两态卡**：朗读设置没有需要区分两态的流程（默认值即可用、不问不弹），
 *   故不做 `configured`（对比 `AnswerStyleCard` 的 L1 选项卡）。
 */
import { useEffect, useState } from 'react';
import {
  DEFAULT_SPEECH_SETTINGS,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  SPEECH_RATE_STEP,
  speechSummary,
} from '@sb/shared';
import type { SpeechSettings } from '@sb/shared';
import { api } from '../../lib/api';
import { canSpeak, englishVoices, setSpeechSettingsCache, speakEnglish } from '../../lib/speech';
import './settings.css';

/** 试听文本：带两个典型词条名，长度够听出语速差别、又不用干等 */
const TRIAL = 'Gradient descent. Learning rate.';

export function SpeechCard({ flash }: { flash: (ok: boolean, text: string) => void }) {
  const [settings, setSettings] = useState<SpeechSettings>(DEFAULT_SPEECH_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /**
   * 本机可用的英文音色。
   * ★ **首次 `getVoices()` 可能是空数组**（浏览器异步加载语音包，Chrome 尤其明显）⇒ 必须
   *   等 `voiceschanged` 事件再列一次。只列一次的症状是「设置页第一次打开时一个音色都没有，
   *   刷新一下又有了」——看着像随机 bug，其实是漏了这个事件。
   */
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    api.settings
      .speech()
      .then((r) => {
        setSettings(r.settings);
        setSpeechSettingsCache(r.settings); // 顺便预热缓存：用户多半是先在设置页选好再去用
      })
      .catch((e) => flash(false, e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const refresh = () => setVoices(englishVoices());
    refresh();
    const synth = canSpeak() ? window.speechSynthesis : null;
    synth?.addEventListener('voiceschanged', refresh);
    return () => synth?.removeEventListener('voiceschanged', refresh);
  }, []);

  /** 保存并回读：屏上显示的必须是服务端归一后的值（同 AnswerStyleCard 的口径） */
  const persist = async (next: SpeechSettings, text: string) => {
    setBusy(true);
    setSettings(next); // 先乐观上屏
    setSpeechSettingsCache(next); // 缓存同步：否则「改了设置但下一次朗读还是旧嗓子」
    try {
      const r = await api.settings.saveSpeech(next);
      setSettings(r.settings);
      setSpeechSettingsCache(r.settings);
      flash(true, `${text}：${speechSummary(r.settings)}`);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
      api.settings
        .speech()
        .then((r) => {
          setSettings(r.settings);
          setSpeechSettingsCache(r.settings);
        })
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const r = await api.settings.resetSpeech();
      setSettings(r.settings);
      setSpeechSettingsCache(r.settings);
      flash(true, '已恢复默认（系统默认英文音色 · 1.0×）');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    // ★ 用屏上当前值（含未保存的草稿）试听——这正是「调完立刻想听听」的诉求
    setSpeechSettingsCache(settings);
    try {
      await speakEnglish(TRIAL);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : String(e));
    }
  };

  const state = loading ? '读取中…' : busy ? '保存中…' : `当前：${speechSummary(settings)}`;
  const speakable = canSpeak();

  return (
    <section className="settings-sec">
      <h3>词条朗读</h3>
      <p className="settings-hint">
        AI 回复里英文词条那个<b>喇叭按钮</b>用的就是这里的音色与语速。音色列表来自<b>本机</b>已安装的
        英文语音（换台电脑可能不一样）；选了本机没有装的音色会自动回落系统默认，不会朗读失败。
      </p>

      {speakable ? (
        <div className="speech-rows">
          <div className="speech-row">
            <label className="speech-label" htmlFor="speech-voice">
              音色
            </label>
            <select
              id="speech-voice"
              className="speech-select"
              value={settings.voiceName}
              disabled={loading || busy}
              onChange={(e) => void persist({ ...settings, voiceName: e.target.value }, '已保存')}
            >
              <option value="">系统默认英文音色</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}（{v.lang}）
                </option>
              ))}
            </select>
          </div>

          <div className="speech-row">
            <label className="speech-label" htmlFor="speech-rate">
              语速
            </label>
            <input
              id="speech-rate"
              className="speech-range"
              type="range"
              min={SPEECH_RATE_MIN}
              max={SPEECH_RATE_MAX}
              step={SPEECH_RATE_STEP}
              value={settings.rate}
              disabled={loading || busy}
              onChange={(e) => setSettings({ ...settings, rate: Number(e.target.value) })}
              // 从事件读值而非读 state：不依赖 React 状态更新的时序（拖动结束时 state 可能还没提交）
              onPointerUp={(e) =>
                void persist({ ...settings, rate: Number((e.target as HTMLInputElement).value) }, '已保存')
              }
              onKeyUp={(e) =>
                void persist({ ...settings, rate: Number((e.target as HTMLInputElement).value) }, '已保存')
              }
            />
            <span className="speech-rate">{settings.rate.toFixed(1)}×</span>
          </div>
        </div>
      ) : (
        <p className="settings-hint warn">当前浏览器不支持语音朗读（未提供 speechSynthesis）。</p>
      )}

      <div className="settings-actions">
        <span className={busy ? 'settings-state' : 'settings-state on'}>{state}</span>
        {/* ★ 不支持语音时**不渲染**试听（而不是禁用）：整个发音能力都不存在了，
            留一个点不动的按钮只会让人猜「为什么不让点」——同 `lib/speech.ts` 的
            「不做假按钮」纪律（那里是喇叭按钮直接不出现）。 */}
        {speakable && (
          <button className="settings-test" disabled={loading || busy} onClick={() => void preview()}>
            试听
          </button>
        )}
        <button className="settings-test" disabled={loading || busy} onClick={() => void reset()}>
          恢复默认
        </button>
      </div>
    </section>
  );
}
