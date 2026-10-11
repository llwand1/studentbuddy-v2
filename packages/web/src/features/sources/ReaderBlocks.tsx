/**
 * ReaderBlocks —— 把块模型渲染成 React 元素（契约 `docs/SOURCE-TRACE-SPEC.md` §14.1）。
 *
 * ★ 第三方 HTML 不注入主文档；文本中的公式仅经受限 KaTeX 生成标记。
 *   第三方内容只以 `ReaderBlock` 上那几个受控字段的形态存在，标签名全由本文件写死，
 *   于是「清洗器漏了什么」不再等价于「主文档被注入什么」。服务端白名单清洗仍在，这是第二道。
 *
 * ★ 每个块挂 `data-rb={id}`：选区反查块、块反查章节都靠它（§14.3）。
 *
 * ★ 链接**不直接跳**：一律 `onFollow(href, text)` 交给上层弹确认条（§14.2 口径 ①）。
 *   这里刻意不渲染成 `<a href>`——渲染成真链接就意味着「中键 / Ctrl+点」仍会跳出去，
 *   那条路绕过了确认，等于留了个后门。
 */
import type { ReaderBlock, ReaderInline } from '@sb/shared';
import { MathText } from '../chat/MathText';

function Spans({ spans, onFollow }: { spans: ReaderInline[]; onFollow: (href: string, label: string) => void }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.t === 'link') {
          return (
            <button key={i} type="button" className="rd-link" title={s.href} onClick={() => onFollow(s.href, s.v)}>
              <MathText text={s.v}/>
            </button>
          );
        }
        if (s.t === 'strong') return <strong key={i}><MathText text={s.v}/></strong>;
        if (s.t === 'em') return <em key={i}><MathText text={s.v}/></em>;
        if (s.t === 'code') return <code key={i}>{s.v}</code>;
        return <span key={i}><MathText text={s.v}/></span>;
      })}
    </>
  );
}

function Block({ b, onFollow }: { b: ReaderBlock; onFollow: (href: string, label: string) => void }) {
  if (b.t === 'hr') return <hr data-rb={b.id} className="rd-hr" />;
  if (b.t === 'img') return <img data-rb={b.id} className="rd-img" src={b.src} alt={b.alt} loading="lazy" referrerPolicy="no-referrer" />;
  if (b.t === 'pre') {
    return (
      <pre data-rb={b.id} className="rd-pre">
        {b.v}
      </pre>
    );
  }
  if (b.t === 'quote') {
    return (
      <blockquote data-rb={b.id} className="rd-quote">
        <Spans spans={b.spans} onFollow={onFollow} />
      </blockquote>
    );
  }
  if (b.t === 'li') {
    return (
      <div data-rb={b.id} className={`rd-li rd-li-d${Math.min(b.depth, 3)}`}>
        <span className="rd-li-dot">{b.ordered ? '·' : '•'}</span>
        <span>
          <Spans spans={b.spans} onFollow={onFollow} />
        </span>
      </div>
    );
  }
  if (b.t === 'h') {
    // 标签名由级别派生，但只在 h1–h6 这个闭集合里取——不是把字符串当标签名用
    const H = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[b.level - 1] ?? 'h3';
    return (
      <H data-rb={b.id} className={`rd-h rd-h${b.level}`}>
        <Spans spans={b.spans} onFollow={onFollow} />
      </H>
    );
  }
  return (
    <p data-rb={b.id} className="rd-p">
      <Spans spans={b.spans} onFollow={onFollow} />
    </p>
  );
}

export function ReaderBlocks({ blocks, onFollow }: { blocks: ReaderBlock[]; onFollow: (href: string, label: string) => void }) {
  return (
    <>
      {blocks.map((b) => (
        <Block key={b.id} b={b} onFollow={onFollow} />
      ))}
    </>
  );
}
