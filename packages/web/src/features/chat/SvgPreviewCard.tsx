/**
 * SvgPreviewCard — ```svg 围栏的内联预览卡（port from v1 SvgPreviewCard，样式改 class）。
 * 渲染前必经 prepareSvg（补闭合/钳宽/白名单净化/白底纸面）；预览和导出使用同一份安全图。
 */
import { useMemo, useState } from 'react';
import { openSvgDocument, parseSvgSize, prepareSvg } from '../../lib/svg-utils';

function fmtDim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function SvgPreviewCard({ code, streaming, label = 'SVG', title = '矢量图片', sourceCode = code }: {
  code: string; streaming: boolean; label?: string; title?: string; sourceCode?: string;
}) {
  const [showSrc, setShowSrc] = useState(false);
  const [copied, setCopied] = useState(false);

  const safe = useMemo(() => prepareSvg(code), [code]);
  const { w, h } = useMemo(() => parseSvgSize(code), [code]);
  const wide = (parseSvgSize(safe).w ?? w ?? 0) > 420;
  const hasSvg = safe.includes('<svg');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sourceCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用静默 */
    }
  };

  return (
    <div className="chat-svg-card">
      <div className="chat-svg-head">
        <span className="chat-svg-badge">{label}</span>
        <span className="chat-svg-title">{title}</span>
        {w !== null && h !== null && (
          <span className="chat-svg-dim">
            {fmtDim(w)} × {fmtDim(h)}
          </span>
        )}
        <span className="chat-svg-actions">
          <button className="chat-svg-btn" onClick={() => openSvgDocument(safe, 'download')} title="下载为 .svg 文件">
            下载
          </button>
          <button className="chat-svg-btn" onClick={() => void copy()} title={`复制${label}源码`}>
            {copied ? '已复制' : '复制'}
          </button>
          <button className="chat-svg-btn" onClick={() => setShowSrc((o) => !o)} title={`查看/隐藏${label}源码`}>
            {showSrc ? '隐藏源码' : '源码'}
          </button>
          <button className="chat-svg-btn" onClick={() => openSvgDocument(safe, 'open')} title="新窗口放大查看">
            放大
          </button>
        </span>
      </div>

      {streaming && !hasSvg ? (
        <div className="chat-svg-body chat-svg-drawing">
          <span className="chat-svg-spin" />
          正在绘制 SVG 图片…
        </div>
      ) : !hasSvg ? (
        // 自愈后仍不是合法 SVG：降级说明 + 源码可查，不再白屏（v1 L2 降级卡语义）
        <div className="chat-svg-body chat-svg-fallback">
          <p>SVG 内容无法解析，已降级为源码显示。</p>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      ) : (
        <div className="chat-svg-body">
          {/* 唯一注入点：内容已过 sanitizeSvg */}
          <div
            className={wide ? 'chat-svg-canvas chat-svg-canvas-wide' : 'chat-svg-canvas'}
            role="region" aria-label={`${label}图面`} tabIndex={0}
            dangerouslySetInnerHTML={{ __html: safe }}
          />
          {wide && <p className="chat-svg-hint">横向滑动查看全图 · 点「放大」查看细节</p>}
        </div>
      )}

      {showSrc && (
        <pre className="chat-svg-src">
          <code>{sourceCode}</code>
        </pre>
      )}
    </div>
  );
}
