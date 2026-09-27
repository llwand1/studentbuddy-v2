/**
 * HtmlCard — ```html 围栏卡：本应用 DOM 内绝不渲染模型写的网页。
 * 点「侧栏预览」才把源码交给 /api/preview 换 id → 右侧内置浏览器面板载入沙箱文档；
 * 「新标签页」是同一条上传路径的备用出口。沙箱文档源为 null ⇒ demo 照跑，碰不到本应用数据。
 */
import { useState } from 'react';
import { pickTitle, uploadPreview } from '../../lib/preview-api';
import { openPreview } from '../../lib/preview-store';

const FALLBACK_TITLE = 'HTML 演示页';

export function HtmlCard({ code, streaming }: { code: string; streaming: boolean }) {
  const [busy, setBusy] = useState<'panel' | 'tab' | ''>('');
  const [errMsg, setErrMsg] = useState('');
  const [showSrc, setShowSrc] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async (mode: 'panel' | 'tab'): Promise<void> => {
    setBusy(mode);
    setErrMsg('');
    try {
      const url = await uploadPreview(code);
      if (mode === 'panel') openPreview(url, pickTitle(code, FALLBACK_TITLE));
      else window.open(url, '_blank', 'noopener');
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用静默 */
    }
  };

  return (
    <div className="chat-svg-card">
      <div className="chat-svg-head">
        <span className="chat-svg-badge">网页</span>
        <span className="chat-svg-title">{pickTitle(code, FALLBACK_TITLE)}</span>
        <span className="chat-svg-dim">{(code.length / 1024).toFixed(1)} KB</span>
        <span className="chat-svg-actions">
          <button
            className="chat-svg-btn primary"
            disabled={streaming || busy !== ''}
            onClick={() => void run('panel')}
            title="在右侧内置浏览器面板打开（隔离沙箱）"
          >
            {busy === 'panel' ? '打开中…' : '侧栏预览'}
          </button>
          <button
            className="chat-svg-btn"
            disabled={streaming || busy !== ''}
            onClick={() => void run('tab')}
            title="在新标签页打开（同一沙箱）"
          >
            {busy === 'tab' ? '打开中…' : '新标签页'}
          </button>
          <button className="chat-svg-btn" onClick={() => void copy()} title="复制 HTML 源码">
            {copied ? '已复制' : '复制'}
          </button>
          <button className="chat-svg-btn" onClick={() => setShowSrc((o) => !o)} title="查看/隐藏 HTML 源码">
            {showSrc ? '隐藏源码' : '源码'}
          </button>
        </span>
      </div>

      {streaming ? (
        <div className="chat-svg-body chat-svg-drawing">
          <span className="chat-svg-spin" />
          正在生成网页…
        </div>
      ) : (
        <div className="chat-svg-body">
          {/* 刻意不内联渲染：demo 页只在沙箱文档（侧栏面板或新标签页）里跑 */}
          <div className="chat-svg-fallback">
            {errMsg ? <p className="chat-error">打开失败：{errMsg}</p> : null}
            <p>交互网页不在对话里直接运行——点「侧栏预览」在右侧面板里跑，或点「新标签页」（都是沙箱隔离，读不到本应用数据）。</p>
          </div>
        </div>
      )}

      {showSrc && (
        <pre className="chat-svg-src">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
