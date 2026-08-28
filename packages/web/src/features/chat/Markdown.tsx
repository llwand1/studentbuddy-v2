/**
 * Markdown — 助手正文渲染（零依赖：块级切分在 lib/markdown.ts，SVG 走净化卡片）。
 * 只做「数据结构 → DOM」，文本节点一律作为 React children 渲染（自动转义），
 * 全篇唯一注入点是 SvgPreviewCard 里的净化后 SVG。
 */
import { useMemo, useState } from 'react';
import type { Block, Inline } from '../../lib/markdown';
import { parseBlocks } from '../../lib/markdown';
import { SvgPreviewCard } from './SvgPreviewCard';
import './markdown.css';

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'strong':
            return <strong key={i}>{n.v}</strong>;
          case 'em':
            return <em key={i}>{n.v}</em>;
          case 'del':
            return <del key={i}>{n.v}</del>;
          case 'code':
            return <code key={i} className="md-inline-code">{n.v}</code>;
          case 'a':
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
                {n.v}
              </a>
            );
          case 'br':
            return <br key={i} />;
          default:
            return <span key={i}>{n.v}</span>;
        }
      })}
    </>
  );
}

function CodeBlock({ block }: { block: Extract<Block, { kind: 'code' }> }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用：静默（正文仍可手动选取复制） */
    }
  };
  return (
    <div className="md-pre">
      <div className="md-pre-head">
        <span className="md-pre-lang">{block.lang || 'text'}</span>
        <button className="md-pre-btn" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code>{block.text}</code>
      </pre>
    </div>
  );
}

function BlockNode({ block, streaming }: { block: Block; streaming: boolean }) {
  switch (block.kind) {
    case 'heading': {
      const inner = <InlineNodes nodes={block.inline} />;
      const level = Math.min(block.level, 4); // 5/6 级标题收敛到 4 级字号，避免正文里出现极小"标题"
      if (level === 1) return <h3 className="md-h md-h1">{inner}</h3>;
      if (level === 2) return <h4 className="md-h md-h2">{inner}</h4>;
      return <h5 className="md-h md-h3">{inner}</h5>;
    }
    case 'para':
      return (
        <p className="md-p">
          <InlineNodes nodes={block.inline} />
        </p>
      );
    case 'ul':
      return (
        <ul className="md-list">
          {block.items.map((it, i) => (
            <li key={i}>
              <InlineNodes nodes={it} />
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="md-list">
          {block.items.map((it, i) => (
            <li key={i}>
              <InlineNodes nodes={it} />
            </li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote className="md-quote">
          {block.lines.map((ln, i) => (
            <span key={i} className="md-quote-line">
              <InlineNodes nodes={ln} />
            </span>
          ))}
        </blockquote>
      );
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((c, i) => (
                  <th key={i}>
                    <InlineNodes nodes={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>
                      <InlineNodes nodes={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'code':
      return <CodeBlock block={block} />;
    case 'svg':
      // 未闭合的围栏 = 仍在流式绘制：卡片自己出"正在绘制"占位，绝不当 HTML 注入
      return <SvgPreviewCard code={block.code} streaming={!block.closed || streaming} />;
    case 'hr':
      return <hr className="md-hr" />;
  }
}

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="md-root">
      {blocks.map((b, i) => (
        <BlockNode key={i} block={b} streaming={streaming} />
      ))}
    </div>
  );
}
