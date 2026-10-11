import { useEffect, useRef, useState } from 'react';
import type { DesktopBrowserState } from '@sb/shared';
import { BrowserControls } from './BrowserControls';
import { desktopApi, isLocalDesktopAddress } from './desktop-api';
import { closeDesktopReader, openDesktopReader, useDesktopReader } from './desktop-reader-store';
import { api } from '../../lib/api';

export function DesktopBrowserEntry({ sessionId, onOpenSession }: { sessionId: string | null; onOpenSession: (id: string) => void }) {
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState('');
  const reader = useDesktopReader();
  const previousSession = useRef(sessionId);
  useEffect(() => {
    if (!isLocalDesktopAddress()) return;
    let live = true;
    void desktopApi.browser().then(() => { if (live) setAvailable(true); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (previousSession.current !== sessionId && reader.open && reader.sessionId !== sessionId) closeDesktopReader();
    previousSession.current = sessionId;
  }, [sessionId, reader.open, reader.sessionId]);
  if (!available) return null;
  return <><button type="button" className="reading-tool" aria-expanded={reader.open} title={error || '和 AI 一起读本地浏览器的网页'} onClick={() => {
    if (reader.open) { closeDesktopReader(); return; }
    setError('');
    if (sessionId) openDesktopReader(sessionId);
    else void api.sessions.create().then(s => { onOpenSession(s.id); openDesktopReader(s.id); }).catch(e => setError(e instanceof Error ? e.message : '创建共读对话失败'));
  }}>网页共读</button>{error && <span role="alert">{error}</span>}</>;
}
export function DesktopReaderPanel({ sessionId }: { sessionId: string }) {
  const [page, setPage] = useState<DesktopBrowserState | null>(null);
  const [setup, setSetup] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = () => { void desktopApi.browser(true).then(r => {
      if (live) { setPage(r.page?.sessionId === sessionId ? r.page : null); setError(''); }
    }).catch(() => { if (live) setError('本机连接中断，正在重连…'); }); };
    refresh(); const timer = window.setInterval(refresh, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId]);
  return <aside className="sb-browser sb-sources desktop-reader" aria-label="动态网页共读">
    <header className="sb-browser-head"><span className="sb-browser-badge">{page?.connected ? '共读中' : '待连接'}</span>
      <span className="sb-browser-title" title={page?.url}>{page?.title || '本地浏览器 · 临时资料'}</span>
      <span className="sb-browser-actions"><button type="button" className="sb-browser-btn" aria-expanded={setup} onClick={() => setSetup(v => !v)}>连接</button>
        <button type="button" className="sb-browser-btn" onClick={closeDesktopReader} aria-label="收起网页共读">×</button></span></header>
    <div className="desktop-reader-scroll">
      {(setup || !page?.connected) && <BrowserControls sessionId={sessionId} />}
      {error && <p role="alert">{error}</p>}
      {page?.connected && <article className="desktop-reader-text"><h2>{page.title}</h2>
        <p className="desktop-reader-meta">随浏览器更新 · {page.chars.toLocaleString()} 字 · 临时索引</p>
        {!!page.selection && <blockquote><small>浏览器当前划选</small><p>{page.selection}</p></blockquote>}
        {(page.text ?? '').split(/\n\s*\n/).filter(Boolean).map((text, i) => <p key={i}>{text}</p>)}
      </article>}
    </div><footer className="src-foot"><span>AI 按当前问题检索相关段落 · 停止共读即清除</span></footer>
  </aside>;
}
