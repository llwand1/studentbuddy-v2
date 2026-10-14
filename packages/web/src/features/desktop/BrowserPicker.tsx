import { useEffect, useState } from 'react';
import { desktopApi } from './desktop-api';
export function BrowserPicker({readerSetupHint=true}:{readerSetupHint?:boolean}={}) {
  const [state, setState] = useState<{selected:'chrome'|'edge';available:Array<'chrome'|'edge'>} | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void desktopApi.browserPreference().then(value => { if (live) setState(value); }).catch(() => {});
    return () => { live = false; };
  }, []);
  if (!state) return null;
  return <div className="desktop-browser-picker"><label>共读与插件使用的浏览器
    <select aria-label="选择共读与插件浏览器" value={state.selected} disabled={busy} onChange={e => {
      const browser = e.target.value as 'chrome'|'edge'; setBusy(true); setError('');
      void desktopApi.chooseBrowser(browser).then(setState).catch(e => setError(e instanceof Error ? e.message : '选择失败')).finally(() => setBusy(false));
    }}>{(['chrome','edge'] as const).map(browser => <option key={browser} value={browser} disabled={!state.available.includes(browser)}>{browser === 'chrome' ? 'Chrome' : 'Edge'}{state.available.includes(browser) ? '' : '（未安装）'}</option>)}</select>
  </label>{error && <p role="alert">{error}</p>}<p className="settings-hint">使用已有浏览器，不改变系统默认浏览器。{readerSetupHint?'首次共读需安装一次扩展。':'此插件入口不需要共读扩展。'}</p></div>;
}
