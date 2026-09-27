/**
 * ChartCard — ```chart 围栏渲染卡（零依赖：解析与 SVG 生成都离线在 lib/chart-utils.ts）。
 * 流式未闭合 → 绘制占位；JSON 不合法 → 降级源码显示（同 SVG 卡的 L2 语义，绝不裸注入）。
 */
import { useMemo, useState } from 'react';
import { parseChart, renderChartSvg } from '../../lib/chart-utils';
import { openSvgDocument, prepareSvg } from '../../lib/svg-utils';

const TYPE_LABEL: Record<string, string> = { bar: '柱状图', line: '折线图', pie: '饼图' };

export function ChartCard({ code, streaming }: { code: string; streaming: boolean }) {
  const [showSrc, setShowSrc] = useState(false);
  const [copied, setCopied] = useState(false);
  const spec = useMemo(() => (streaming ? null : parseChart(code)), [code, streaming]);
  const safe = useMemo(() => (spec ? prepareSvg(renderChartSvg(spec)) : ''), [spec]);

  const copy = async () => {
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
        <span className="chat-svg-badge">图表</span>
        <span className="chat-svg-title">{spec ? TYPE_LABEL[spec.type] : '数据图表'}</span>
        {spec?.title && <span className="chat-svg-dim">{spec.title}</span>}
        {spec && (
          <span className="chat-svg-actions">
            <button className="chat-svg-btn" onClick={() => openSvgDocument(safe, 'download')} title="下载为 .svg 文件">
              下载
            </button>
            <button className="chat-svg-btn" onClick={() => void copy()} title="复制 chart JSON">
              {copied ? '已复制' : '复制'}
            </button>
            <button className="chat-svg-btn" onClick={() => setShowSrc((o) => !o)} title="查看/隐藏 JSON 源码">
              {showSrc ? '隐藏源码' : '源码'}
            </button>
            <button className="chat-svg-btn" onClick={() => openSvgDocument(safe, 'open')} title="新窗口放大查看">
              放大
            </button>
          </span>
        )}
      </div>

      {streaming ? (
        <div className="chat-svg-body chat-svg-drawing">
          <span className="chat-svg-spin" />
          正在生成图表…
        </div>
      ) : !spec ? (
        <div className="chat-svg-body chat-svg-fallback">
          <p>图表 JSON 无法解析（需要 type: bar/line/pie），已降级为源码显示。</p>
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      ) : (
        <div className="chat-svg-body">
          {/* 注入点：renderChartSvg 自产（文本已 esc）+ prepareSvg 净化 */}
          <div className="chat-svg-canvas" dangerouslySetInnerHTML={{ __html: safe }} />
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
