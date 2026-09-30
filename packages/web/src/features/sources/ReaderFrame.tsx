/**
 * ReaderFrame —— 网页类资料在面板里的那一格：阅读页 iframe + **截图保底**（契约 docs/SOURCE-TRACE-SPEC.md §13.1）。
 *
 * 挂 iframe 的同时向 `/probe` 问一句这页的底细（同一次取页，服务端合流），然后分三路：
 *  - 打不开（403 / 非网页 / 超时）且服务器能截图 ⇒ **自动**换成截图视图（iframe 里的失败页只是一闪）；
 *  - 打得开但正文太薄（脚本渲染页）且能截图 ⇒ 阅读页照显示，顶上给一条「用服务器截图看全」的出口，学习者自己决定；
 *  - 服务器没浏览器 ⇒ 什么都不加：失败页本身已如实写了「截不了图 · 新标签页打开」。
 * 探测请求自己失败（网络抖动）也不影响 iframe——它只是锦上添花的信息。
 *
 * 截图为什么是顶层文档里的 `<img>` 而不是塞进阅读页：阅读页在 CSP `sandbox` 里是不透明源，
 * 它发出的子资源请求带不上 `SameSite=Lax` 的会话 cookie，`/shot` 会被鉴权挡下。
 */
import { useEffect, useState } from 'react';
import type { SourceItem } from '@sb/shared';
import { probeReader, shotUrl, type ReaderProbe } from '../../lib/api-sources';
import { readerUrl } from '../../lib/sources-store';

type Probe = { phase: 'wait' } | { phase: 'unknown' } | ({ phase: 'known' } & ReaderProbe);

function ShotView({ sessionId, item, onBack }: { sessionId: string; item: SourceItem; onBack: () => void }) {
  const [st, setSt] = useState<'loading' | 'ok' | 'error'>('loading');
  const src = shotUrl(sessionId, item.url);
  const text =
    st === 'loading'
      ? '阅读模式打不开这一页，服务器正在用浏览器截图…（最多约 20 秒）'
      : st === 'ok'
        ? '这是服务器刚截的原网页首屏：是一张图，点不了；要往下看请开原网页'
        : '截图也没成（对方可能拦了服务器，或页面一直加载不完）；请在新标签页打开原网页';
  return (
    <div className={`src-shot ${st}`} role="group" aria-label="网页截图">
      <div className="src-thin shot">
        <span>{text}</span>
        <button type="button" className="src-thin-btn" onClick={onBack}>
          阅读模式
        </button>
        <button type="button" className="src-thin-btn" onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}>
          原网页 ↗
        </button>
      </div>
      <div className="src-shot-scroll">
        {st !== 'error' && (
          <img key={src} className="src-shot-img" src={src} alt={`${item.title} 的网页截图`} onLoad={() => setSt('ok')} onError={() => setSt('error')} />
        )}
        {st === 'loading' && <p className="src-shot-wait">截图中…</p>}
      </div>
    </div>
  );
}

export function ReaderFrame({ sessionId, item }: { sessionId: string; item: SourceItem }) {
  const [probe, setProbe] = useState<Probe>({ phase: 'wait' });
  const [mode, setMode] = useState<'reader' | 'shot'>('reader');
  const src = readerUrl(sessionId, item);

  // 依赖取字段而不是 item 本身：live 帧整表替换会换对象，但同一网址不该再探一次
  const { url, title, kind } = item;
  useEffect(() => {
    setProbe({ phase: 'wait' });
    setMode('reader');
    if (kind === 'image') return; // 图片阅读页永远打得开，不值得多问一次
    const ac = new AbortController();
    probeReader(sessionId, url, title, ac.signal).then(
      (p) => {
        if (ac.signal.aborted) return;
        setProbe({ phase: 'known', ...p });
        if (!p.ok && p.shot) setMode('shot');
      },
      () => {
        if (!ac.signal.aborted) setProbe({ phase: 'unknown' });
      },
    );
    return () => ac.abort();
  }, [sessionId, url, title, kind]);

  if (mode === 'shot') return <ShotView sessionId={sessionId} item={item} onBack={() => setMode('reader')} />;
  const offer = probe.phase === 'known' && probe.ok && probe.thin && probe.shot;
  return (
    <>
      {offer && (
        <div className="src-thin" role="note">
          <span>这页正文主要靠脚本渲染，阅读模式只拿到一小部分</span>
          <button type="button" className="src-thin-btn" onClick={() => setMode('shot')}>
            用服务器截图看全
          </button>
        </div>
      )}
      <iframe key={src} className="sb-browser-frame src-frame" src={src} title={item.title} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
    </>
  );
}
