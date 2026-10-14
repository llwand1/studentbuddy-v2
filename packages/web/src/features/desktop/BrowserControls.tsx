import { useEffect, useState } from 'react';
import type { Session, DesktopBrowserState } from '@sb/shared';
import { api } from '../../lib/api';
import { desktopApi } from './desktop-api';
import { hasHost, postToHost } from '../float/float-view';
import './desktop-study.css';
import { launchNativeReader } from './native-reader';
import { BrowserPicker } from './BrowserPicker';

export function BrowserControls({ sessionId, onBound }: { sessionId?: string | null; onBound?: (id: string) => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [target, setTarget] = useState(sessionId ?? '');
  const [page, setPage] = useState<DesktopBrowserState | null>(null);
  const [pair, setPair] = useState<{ code: string; endpoint: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (sessionId) setTarget(sessionId); }, [sessionId]);
  useEffect(() => {
    let live = true;
    void api.sessions.list().then(items => { if (live) setSessions(items); }).catch(() => {});
    const refresh = () => { void desktopApi.browser().then(r => { if (live) { setPage(r.page); if (r.page) setTarget(id => id || r.page!.sessionId); } }).catch(() => {}); };
    refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  const generate = async () => {
    setBusy(true); setError('');
    try {
      const id = sessionId || target || (await api.sessions.create()).id;
      setTarget(id); onBound?.(id);
      setPair(await desktopApi.pair(id));
    } catch (e) { setError(e instanceof Error ? e.message : '配对失败，请重试'); }
    finally { setBusy(false); }
  };
  return <section className="desktop-browser-controls" aria-label="本地网页共读">
    <h3>网页共读 <span className={page?.connected ? 'desktop-online' : ''}>{page?.connected ? page.chars ? '● 正在同步' : '○ 暂无可读正文' : '○ 未同步'}</span></h3>
    <BrowserPicker />
    <div className="desktop-extension-install"><strong>第一次共读？不用找安装目录</strong><p>下载扩展 ZIP，解压后在浏览器扩展页「加载已解压」并选择含 manifest.json 的文件夹。安装一次即可。</p>
      <a className="sb-browser-btn" href="/desktop-reader-extension.zip" download="StudentBuddy-reader-extension.zip">下载共读扩展 ZIP</a>
      {hasHost() && <button type="button" onClick={() => postToHost('sb-desktop:extension')}>打开已安装的扩展文件夹</button>}
    </div>
    <p>跳转到选定浏览器，点击「连接此对话」；再打开目标网页，点击扩展里的「共读当前页」。无需填写地址和配对码。</p>
      <button type="button" disabled={busy} onClick={() => {
        setBusy(true); setError('');
        void (async () => { const id = sessionId || target || (await api.sessions.create()).id; setTarget(id); onBound?.(id); await desktopApi.openReader(id); })()
          .catch(e => setError(e instanceof Error ? e.message : '打开失败')).finally(() => setBusy(false));
      }}>跳转浏览器开始共读</button>
    <details><summary>首次安装扩展 / 备用连接方式</summary>
    <p>在 Chrome／Edge 中选择一个网页，正文、划选和当前视野会随阅读更新。AI 只在绑定的对话里检索这份临时材料。</p>
    {page?.connected && <p className="desktop-page-name" title={page.url}>{page.title || page.url}<small>{page.chars.toLocaleString()} 字 · 快照 {page.revision}</small></p>}
    <label>共读对话<select value={target} disabled={!!sessionId || busy} onChange={e => { setTarget(e.target.value); setPair(null); }}>
      <option value="">新建共读对话</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.title || '未命名对话'}</option>)}
      {!!target && !sessions.some(s => s.id === target) && <option value={target}>{sessionId ? '当前对话' : '共读对话'}</option>}
    </select></label>
    <div className="desktop-actions"><button type="button" disabled={busy} onClick={() => void generate()}>{busy ? '准备中…' : '生成配对码'}</button>
    </div>
    {pair && <div className="desktop-pair" aria-live="polite"><strong>{pair.code}</strong><code>{pair.endpoint}</code><small>5 分钟内填入扩展，再点「共读当前页」。重新配对会替换原连接。</small></div>}
    <p>首次打开 chrome://extensions 或 edge://extensions，开启开发者模式，点「加载已解压的扩展程序」，选择安装目录里的 browser-extension 文件夹。扩展固定到工具栏后，重新跳转即可自动填好连接信息。</p><p>切到其他站点后需再次点击「共读当前页」。关闭选中标签页、停止同步或超过一分钟没有新快照，当前网页文字就会清除。</p>
    {hasHost() && <button type="button" disabled={busy} onClick={() => {
      setBusy(true);setError('');void launchNativeReader(sessionId || target).catch(e => setError(e instanceof Error ? e.message : '打开失败')).finally(() => setBusy(false));
    }}>备用：打开内置共读窗口</button>}
    </details>
    {page && <button type="button" disabled={busy} className="desktop-stop" onClick={() => {
      setBusy(true); void desktopApi.stopBrowser().then(() => { setPage(null); setPair(null); })
        .catch(e => setError(e instanceof Error ? e.message : '停止失败，请重试')).finally(() => setBusy(false));
    }}>停止共读并清除临时材料</button>}
    {error && <p role="alert" className="desktop-error">{error}</p>}
  </section>;
}
