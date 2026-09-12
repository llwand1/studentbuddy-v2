/**
 * Markdown — 助手正文渲染（零依赖：块级切分在 lib/markdown.ts，SVG/图表走净化卡片）。
 * 只做「数据结构 → DOM」，文本节点一律作为 React children 渲染（自动转义），
 * 全篇注入点只有 SvgPreviewCard / ChartCard 里净化后的 SVG；```html 永不内联（HtmlCard 只给
 * 「新标签页打开」，由服务端 CSP sandbox 隔离）。
 *
 * 流式性能（批次二）：长回答若每帧全量重解析整篇 Markdown，总开销是 O(n²)——越流越卡。
 * 现按 stableCut 把文本切成「已闭合块（stable）+ 正在书写的块（tail）」：
 * stable 的块对象跨帧复用同一引用，配合 memo 化的 BlockNode 直接跳过重渲染；
 * 每帧只重解析 tail，成本从「整篇」降到「最后一块」。
 */
import { memo, useMemo, useRef, useState } from 'react';
import type { Block, Inline, ListItem, ListTree } from '../../lib/markdown';
import { parseBlocks, remedy, stableCut } from '../../lib/markdown';
import { highlightCode, highlightStable, extFor } from '../../lib/highlight';
import { SvgPreviewCard } from './SvgPreviewCard';
import { ChartCard } from './ChartCard';
import { HtmlCard } from './HtmlCard';
import './markdown.css';

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case 'strong':
            return <strong key={i}><InlineNodes nodes={n.children} /></strong>;
          case 'em':
            return <em key={i}><InlineNodes nodes={n.children} /></em>;
          case 'del':
            return <del key={i}><InlineNodes nodes={n.children} /></del>;
          case 'code':
            return <code key={i} className="md-inline-code">{n.v}</code>;
          case 'a':
            return (
              <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
                <InlineNodes nodes={n.children} />
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

/** 列表渲染：checked 非空 = 任务项（只读 checkbox）；children = 缩进子列表（类型可与父层不同） */
function ListItems({ items, ordered }: { items: ListItem[]; ordered: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className="md-list">
      {items.map((it, i) => (
        <li key={i} className={it.checked !== undefined ? 'md-task' : undefined}>
          {it.checked !== undefined && <input type="checkbox" className="md-task-box" checked={it.checked} readOnly />}
          <InlineNodes nodes={it.inline} />
          {it.children?.map((sub: ListTree, j) => (
            <ListItems key={j} items={sub.items} ordered={sub.ordered} />
          ))}
        </li>
      ))}
    </Tag>
  );
}

/** 超过这个行数的代码块默认折叠（C-N-W 的 enableCodeFold 同款默认行为） */
const FOLD_LINES = 25;

function CodeBlock({ block }: { block: Extract<Block, { kind: 'code' }> }) {
  const [copied, setCopied] = useState(false);
  const lineCount = useMemo(() => block.text.split('\n').length, [block.text]);
  const [folded, setFolded] = useState(lineCount > FOLD_LINES);
  /**
   * 高亮分两档：围栏闭合后全量重算（最准）；流式中只给「已完整换行」的部分上色——
   * 末行内容每帧都在变，对它上色会整块闪；已换行的行内容已定，可以稳定着色。
   * 不支持的语言两个入口都返回 null，回落纯文本。
   */
  const tokens = useMemo(
    () =>
      block.closed
        ? highlightCode(block.text, block.lang)
        : highlightStable(block.text, block.lang),
    [block.text, block.lang, block.closed],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用：静默（正文仍可手动选取复制） */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([block.text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `snippet.${extFor(block.lang)}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="md-pre">
      <div className="md-pre-head">
        <span className="md-pre-lang">{block.lang || 'text'}</span>
        <span className="md-pre-actions">
          <button className="md-pre-btn" onClick={download}>
            下载
          </button>
          <button className="md-pre-btn" onClick={() => void copy()}>
            {copied ? '已复制' : '复制'}
          </button>
        </span>
      </div>
      <pre className={folded ? 'md-pre-folded' : undefined}>
        <code>
          {tokens
            ? tokens.map((t, i) => (t.t === 'x' ? t.v : <span key={i} className={`hl-${t.t}`}>{t.v}</span>))
            : block.text}
        </code>
      </pre>
      {lineCount > FOLD_LINES && (
        <button className="md-pre-toggle" onClick={() => setFolded((f) => !f)}>
          {folded ? `展开全部 ${lineCount} 行` : '收起'}
        </button>
      )}
    </div>
  );
}

/** memo 化：stable 块的 block 引用跨帧不变，这里直接跳过重渲染（性能设计见文件头） */
const BlockNode = memo(function BlockNode({ block, streaming }: { block: Block; streaming: boolean }) {
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
      return <ListItems items={block.items} ordered={false} />;
    case 'ol':
      return <ListItems items={block.items} ordered={true} />;
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
    case 'chart':
      return <ChartCard code={block.code} streaming={!block.closed || streaming} />;
    case 'html':
      return <HtmlCard code={block.code} streaming={!block.closed || streaming} />;
    case 'hr':
      return <hr className="md-hr" />;
  }
});

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  /**
   * 流式半截语法先补尾再解析：token 是逐段到的，不补的话屏幕会闪出 `**`、`  ` 这类原始记号，
   * 下一帧闭合时又跳一次。只在流式渲染时补——落库、导出、复制一律用原文，
   * 否则补出来的尾巴会被写进历史消息，下次从库里读出来就多一对星号。
   */
  const src = streaming ? remedy(text) : text;

  /**
   * 增量解析游标：upto = 已解析到的字符位置，stable = 该前缀的块（跨帧复用引用）。
   * 流式文本单调增长；长度回缩 = 新一轮开始，游标归零。非流式（历史消息）整篇解析不缓存。
   */
  const incRef = useRef<{ upto: number; stable: Block[] }>({ upto: 0, stable: [] });
  const { stable, tail } = useMemo(() => {
    if (!streaming) {
      incRef.current = { upto: 0, stable: [] };
      return { stable: [] as Block[], tail: parseBlocks(src) };
    }
    const cur = incRef.current.upto > src.length ? { upto: 0, stable: [] } : incRef.current;
    const cut = stableCut(src);
    if (cut > cur.upto) {
      // 只解析「上次游标 → 本帧切点」之间新闭合的块，旧的直接复用
      cur.stable = [...cur.stable, ...parseBlocks(src.slice(cur.upto, cut))];
      cur.upto = cut;
    }
    incRef.current = cur;
    return { stable: cur.stable, tail: parseBlocks(src.slice(cur.upto)) };
  }, [src, streaming]);

  return (
    <div className="md-root">
      {stable.map((b, i) => (
        <BlockNode key={`s${i}`} block={b} streaming={false} />
      ))}
      {tail.map((b, i) => (
        <BlockNode key={`t${i}`} block={b} streaming={streaming} />
      ))}
    </div>
  );
}
