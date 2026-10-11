import { useEffect, useState } from 'react';
import type { Session, DesktopBrowserState } from '@sb/shared';
import { api } from '../../lib/api';
import { desktopApi } from './desktop-api';
import { hasHost, postToHost } from '../float/float-view';
import './desktop-study.css';

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
    <p>在 Chrome／Edge 中选择一个网页，正文、划选和当前视野会随阅读更新。AI 只在绑定的对话里检索这份临时材料。</p>
    {page?.connected && <p className="desktop-page-name" title={page.url}>{page.title || page.url}<small>{page.chars.toLocaleString()} 字 · 快照 {page.revision}</small></p>}
    <label>共读对话<select value={target} disabled={!!sessionId || busy} onChange={e => { setTarget(e.target.value); setPair(null); }}>
      <option value="">新建共读对话</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.title || '未命名对话'}</option>)}
      {!!sessionId && !sessions.some(s => s.id === sessionId) && <option value={sessionId}>当前对话</option>}
    </select></label>
    <div className="desktop-actions"><button type="button" disabled={busy} onClick={() => void generate()}>{busy ? '准备中…' : '生成配对码'}</button>
      {hasHost() && <button type="button" onClick={() => postToHost('sb-desktop:extension')}>打开扩展文件夹</button>}</div>
    {pair && <div className="desktop-pair" aria-live="polite"><strong>{pair.code}</strong><code>{pair.endpoint}</code><small>5 分钟内填入扩展，再点「共读当前页」。重新配对会替换原连接。</small></div>}
    <details><summary>首次连接方法</summary><p>打开 chrome://extensions 或 edge://extensions，开启开发者模式，点「加载已解压的扩展程序」，选择安装目录里的 browser-extension 文件夹。将配对码和本机地址填入扩展。</p><p>切到其他站点后需再次点击「共读当前页」。关闭选中标签页、停止同步或超过一分钟没有新快照，当前网页文字就会清除。</p></details>
    {page && <button type="button" disabled={busy} className="desktop-stop" onClick={() => {
      setBusy(true); void desktopApi.stopBrowser().then(() => { setPage(null); setPair(null); })
        .catch(e => setError(e instanceof Error ? e.message : '停止失败，请重试')).finally(() => setBusy(false));
    }}>停止共读并清除临时材料</button>}
    {error && <p role="alert" className="desktop-error">{error}</p>}
  </section>;
}
