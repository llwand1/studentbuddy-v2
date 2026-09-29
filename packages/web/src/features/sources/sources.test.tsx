// @vitest-environment jsdom
/**
 * 资料架前端组件级回归锁（契约 docs/SOURCE-TRACE-SPEC.md §8）：
 * ① 面板：按精选→读过→搜到排标签、当前条高亮、在读标、精选理由条、iframe 按类型分三路
 *    （网页=沙箱阅读页、视频=官方播放器、PDF=转发且**不加 sandbox**）、原网页按钮、演示面板开着时让位；
 * ② 键位：[ ] / Alt+← → / Alt+k，打字中不生效；
 * ③ 引用芯片：消息自带架子优先、架上没有的编号原样显示、点击打开面板到第 n 条；流式正文回落 live 架；
 * ④ 解析：`[n]` / `[1, 3]` 成 cite 节点，`a[1]` 与 `[x](url)` 不算；
 * ⑤ chat-blocks 分派 sources 帧进 store、坏帧忽略；history-fold 透传 sources 列；脚注「资料 n 条」。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import type { SourceItem } from '@sb/shared';
import { parseInline } from '../../lib/markdown-inline';
import { applyLiveSources, getSources, openSources, resetSourcesStore } from '../../lib/sources-store';
import { closePreview, openPreview } from '../../lib/preview-store';
import { applyChatBlock } from '../chat/chat-blocks';
import { foldToolRounds } from '../chat/history-fold';
import { Markdown } from '../chat/Markdown';
import { MessageFoot } from '../chat/MessageFoot';
import { CiteChip, MessageSourcesProvider } from './cite';
import { SourcePanel } from './SourcePanel';
import { handleSourceKey } from './useSourceKeys';

const item = (n: number, origin: SourceItem['origin'] = 'search', kind: SourceItem['kind'] = 'page', extra: Partial<SourceItem> = {}): SourceItem => ({
  n,
  url: kind === 'video' ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' : `https://x.example.com/${n}${kind === 'pdf' ? '.pdf' : ''}`,
  title: `T${n}`,
  site: 'x.example.com',
  kind,
  origin,
  ...extra,
});

beforeEach(() => {
  resetSourcesStore();
  closePreview();
});
afterEach(cleanup);

describe('① SourcePanel', () => {
  it('标签顺序精选→读过→搜到、当前高亮、在读标、精选理由、网页走沙箱阅读页', () => {
    applyLiveSources({ kind: 'sources', sessionId: 's1', items: [item(1), item(2, 'read'), item(3, 'pick', 'page', { why: '官方文档' })], readingN: 2 });
    const { container } = render(<SourcePanel />);
    const tabs = Array.from(container.querySelectorAll('.src-tab')).map((t) => t.querySelector('.src-tab-n')?.textContent);
    expect(tabs).toEqual(['3', '2', '1']);
    expect(container.querySelector('.src-tab.active .src-tab-n')?.textContent).toBe('3');
    expect(container.querySelector('.src-tab-reading')).not.toBeNull();
    expect(container.querySelector('.src-note.pick')?.textContent).toContain('官方文档');
    expect(container.querySelector('.sb-browser-badge')?.textContent).toBe('AI 在看');
    const frame = container.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toMatch(/^\/api\/sources\/view\?session=s1&url=https%3A%2F%2Fx\.example\.com%2F3/);
    expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    fireEvent.click(container.querySelectorAll('.src-tab')[2] as HTMLElement);
    expect(getSources().activeN).toBe(1);
    expect(container.querySelector('.src-foot')?.textContent).toContain('3 / 3');
  });

  it('视频=官方播放器（带脚本沙箱）；PDF=转发且不加 sandbox；原网页按钮新标签打开；× 关闭', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    openSources('s1', [item(1, 'search', 'video'), item(2, 'search', 'pdf')], 1);
    const { container, rerender } = render(<SourcePanel />);
    let frame = container.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    fireEvent.keyDown(window, { key: ']' });
    rerender(<SourcePanel />);
    frame = container.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toMatch(/^\/api\/sources\/pdf\?/);
    expect(frame.hasAttribute('sandbox')).toBe(false);
    fireEvent.click(container.querySelector('.sb-browser-actions .sb-browser-btn') as HTMLElement);
    expect(open).toHaveBeenCalledWith('https://x.example.com/2.pdf', '_blank', 'noopener,noreferrer');
    fireEvent.click(container.querySelector('.sb-browser-close') as HTMLElement);
    expect(getSources().open).toBe(false);
    open.mockRestore();
  });

  it('演示面板开着时让位（返回空），演示关掉回来', () => {
    openSources('s1', [item(1)]);
    openPreview('/api/preview/abc', 'demo');
    const { container, rerender } = render(<SourcePanel />);
    expect(container.querySelector('.sb-sources')).toBeNull();
    closePreview();
    rerender(<SourcePanel />);
    expect(container.querySelector('.sb-sources')).not.toBeNull();
  });
});

describe('② 键位', () => {
  it('[ ] 与 Alt+←→ 切换、Alt+k 直达；输入框里不生效；Ctrl 组合不管', () => {
    openSources('s1', [item(1), item(2), item(3)], 1);
    const body = document.body;
    expect(handleSourceKey({ key: ']', altKey: false, ctrlKey: false, metaKey: false, target: body })).toBe(true);
    expect(getSources().activeN).toBe(2);
    expect(handleSourceKey({ key: 'ArrowLeft', altKey: true, ctrlKey: false, metaKey: false, target: body })).toBe(true);
    expect(getSources().activeN).toBe(1);
    expect(handleSourceKey({ key: '3', altKey: true, ctrlKey: false, metaKey: false, target: body })).toBe(true);
    expect(getSources().activeN).toBe(3);
    const ta = document.createElement('textarea');
    expect(handleSourceKey({ key: '[', altKey: false, ctrlKey: false, metaKey: false, target: ta })).toBe(false);
    expect(handleSourceKey({ key: '[', altKey: false, ctrlKey: true, metaKey: false, target: body })).toBe(false);
    expect(getSources().activeN).toBe(3);
  });
});

describe('③ 引用芯片 + ④ 解析', () => {
  it('parseInline：[2] / [1, 3] / [1][2] 成 cite；a[1] 与 [文](url) 不算', () => {
    expect(parseInline('据[2]所述')).toEqual([{ t: 'text', v: '据' }, { t: 'cite', n: 2 }, { t: 'text', v: '所述' }]);
    expect(parseInline('[1, 3]')).toEqual([{ t: 'cite', n: 1 }, { t: 'cite', n: 3 }]);
    expect(parseInline('[1][2]')).toEqual([{ t: 'cite', n: 1 }, { t: 'cite', n: 2 }]);
    expect(parseInline('a[1]')).toEqual([{ t: 'text', v: 'a[1]' }]);
    expect(parseInline('[文](https://a.example)')[0]?.t).toBe('a');
  });

  it('消息自带架子：有第 n 条 ⇒ 芯片，点了打开面板到 n；没有 ⇒ 原样文字', () => {
    const sources = [item(1), item(2, 'pick', 'page', { why: 'w' })];
    const { container } = render(
      <MessageSourcesProvider sessionId="s7" sources={sources}>
        <Markdown text={'见 [2] 与 [9]'} />
      </MessageSourcesProvider>,
    );
    const chip = container.querySelector('button.md-cite') as HTMLButtonElement;
    expect(chip.textContent).toBe('2');
    expect(chip.classList.contains('md-cite-pick')).toBe(true);
    expect(container.textContent).toContain('[9]');
    fireEvent.click(chip);
    expect(getSources()).toMatchObject({ open: true, sessionId: 's7', activeN: 2 });
  });

  it('流式正文（无 Provider）回落 live 架；live 结束后不再回落', () => {
    applyLiveSources({ kind: 'sources', sessionId: 's1', items: [item(1)] });
    const { container, rerender } = render(<CiteChip n={1} />);
    expect(container.querySelector('button.md-cite')).not.toBeNull();
    openSources('s2', [item(4)]);
    rerender(<CiteChip n={1} />);
    expect(container.querySelector('button.md-cite')).toBeNull();
    expect(container.textContent).toBe('[1]');
  });
});

describe('⑤ 分派 / 历史 / 脚注', () => {
  it('applyChatBlock：sources 帧进 store 不进消息流；坏帧忽略', () => {
    let out: unknown[] = [];
    const set = (u: (ms: unknown[]) => unknown[]) => {
      out = u(out);
    };
    applyChatBlock(set, 'sources:s1', { kind: 'sources', sessionId: 's1', items: [item(1)] });
    expect(out).toHaveLength(0);
    expect(getSources().items).toHaveLength(1);
    applyChatBlock(set, 'sources:s1', { kind: 'sources', sessionId: 's1' });
    expect(getSources().items).toHaveLength(1);
  });

  it('foldToolRounds 透传 sources 列（空数组不带键）；MessageFoot 出「资料 n 条」并打开面板', () => {
    const rows = foldToolRounds([
      { id: 'u', role: 'user', content: 'q', created_at: '2026-09-30 00:00:00' },
      { id: 'a', role: 'assistant', content: 'ans', created_at: '2026-09-30 00:00:01', sources: [item(1), item(2)] },
      { id: 'b', role: 'assistant', content: 'ans2', created_at: '2026-09-30 00:00:02', sources: [] },
    ]);
    expect(rows[1]?.sources).toHaveLength(2);
    expect('sources' in (rows[2] ?? {})).toBe(false);
    const { getByText } = render(<MessageFoot content="ans" sessionId="s1" sources={rows[1]?.sources} />);
    fireEvent.click(getByText('资料 2 条'));
    expect(getSources()).toMatchObject({ open: true, sessionId: 's1' });
  });
});
