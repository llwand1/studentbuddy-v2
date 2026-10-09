// @vitest-environment jsdom
/**
 * 资料架前端组件级回归锁（契约 docs/SOURCE-TRACE-SPEC.md §8）：
 * ① 面板：按精选→读过→搜到排标签、当前条高亮、在读标、精选理由条、iframe 按类型分三路
 *    （网页=沙箱阅读页、视频=官方播放器、PDF=转发且**不加 sandbox**）、原网页按钮、演示面板开着时让位；
 * ② 键位：[ ] / Alt+← → / Alt+k，打字中不生效；
 * ③ 引用芯片：消息自带架子优先、架上没有的编号原样显示、点击打开面板到第 n 条；流式正文回落 live 架；
 * ④ 解析：`[n]` / `[1, 3]` 成 cite 节点，`a[1]` 与 `[x](url)` 不算；
 * ⑤ chat-blocks 分派 sources 帧进 store、坏帧忽略；history-fold 透传 sources 列；脚注「资料 n 条」；
 * ⑥（2026-09-30）单条 ✕：叉掉后从架上消失、选中落到下一条、live 整表替换/收口归位不把它端回来、一条不剩面板收起。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import type { SourceItem } from '@sb/shared';
import { parseInline } from '../../lib/markdown-inline';
import { applyLiveSources, getSources, openSources, reopenSources, removeSource, resetSourcesStore, takeTurnSources } from '../../lib/sources-store';
import { closePreview, openPreview } from '../../lib/preview-store';
import { resetVideoRouteStore } from '../../lib/video-route-store';
import { applyChatBlock } from '../chat/chat-blocks';
import { foldToolRounds } from '../chat/history-fold';
import { Markdown } from '../chat/Markdown';
import { MessageFoot } from '../chat/MessageFoot';
import { CiteChip, MessageSourcesProvider } from './cite';
import { SourcePanel } from './SourcePanel';
import { handleSourceKey } from './useSourceKeys';

// 网页格会顺手探测阅读页（截图保底，见 ReaderFrame.test）：这里桩成永不返回，面板行为与探测无关
vi.mock('../../lib/api-sources', () => ({
  readReaderPage: () => new Promise(() => undefined),
  followSource: () => Promise.resolve({ ok: true, url: '', site: '' }),
  probeReader: () => new Promise(() => undefined),
  shotUrl: (sessionId: string, url: string) => `/api/sources/shot?session=${sessionId}&url=${encodeURIComponent(url)}`,
  searchVideos: () => new Promise(() => undefined),
}));

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
  resetVideoRouteStore();
  closePreview();
});
afterEach(cleanup);

describe('① SourcePanel', () => {
  it('标签顺序精选→读过→搜到、当前高亮、在读标、精选理由、网页走沙箱阅读页', () => {
    applyLiveSources({ kind: 'sources', sessionId: 's1', items: [item(1), item(2, 'read'), item(3, 'pick', 'page', { why: '官方文档' })], readingN: 2 });
    reopenSources();
    const { container } = render(<SourcePanel />);
    const tabs = Array.from(container.querySelectorAll('.src-tab')).map((t) => t.querySelector('.src-tab-n')?.textContent);
    expect(tabs).toEqual(['3', '2', '1']);
    expect(container.querySelector('.src-tab.active .src-tab-n')?.textContent).toBe('3');
    expect(container.querySelector('.src-tab-reading')).not.toBeNull();
    expect(container.querySelector('.src-note.pick')?.textContent).toContain('官方文档');
    expect(container.querySelector('.sb-browser-badge')?.textContent).toBe('AI 在看');
    // 2026-10-04（SOURCE-TRACE-SPEC §14.1）：网页类资料不再是 sandbox iframe，而是主文档里的 ReaderView
    // ——这是划线功能的前提（iframe 不给 allow-same-origin 就读不到选区）。
    // 这里钉「网页类不再出现 iframe」：一旦有人把它改回 iframe，划线会整条静默失效。
    expect(container.querySelector('[data-testid="reader-body"]')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
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
    fireEvent.click(Array.from(container.querySelectorAll('.sb-browser-actions .sb-browser-btn')).find((b) => b.textContent === '原网页') as HTMLElement);
    expect(open).toHaveBeenCalledWith('https://x.example.com/2.pdf', '_blank', 'noopener,noreferrer');
    fireEvent.click(container.querySelector('.sb-browser-close') as HTMLElement);
    expect(getSources().open).toBe(false);
    open.mockRestore();
  });

  it('⑥ 单条 ✕：叉掉当前条 ⇒ 选中落到下一条；live 帧再来也不复活；收口归位时也不带它；叉光了面板收起', () => {
    applyLiveSources({ kind: 'sources', sessionId: 's1', items: [item(1), item(2, 'read'), item(3, 'pick', 'page', { why: '官方' })] });
    reopenSources();
    const { container, rerender } = render(<SourcePanel />);
    expect(container.querySelectorAll('.src-tab-x')).toHaveLength(3);
    fireEvent.click(container.querySelector('.src-tab-wrap.active .src-tab-x') as HTMLElement); // 叉掉正在看的 3 号（精选）
    rerender(<SourcePanel />);
    expect(getSources().items.map((s) => s.n)).toEqual([1, 2]);
    expect(getSources().activeN).toBe(2);
    expect(container.querySelector('.src-foot')?.textContent).toContain('1 / 2');
    // AI 又搜了一次：整表替换里 3 号还在，但用户叉过 ⇒ 不复活；新来的 4 号照上
    applyLiveSources({ kind: 'sources', sessionId: 's1', items: [item(1), item(2, 'read'), item(3, 'pick'), item(4)] });
    expect(getSources().items.map((s) => s.n)).toEqual([1, 2, 4]);
    expect(takeTurnSources('s1').sources?.map((s) => s.n)).toEqual([1, 2, 4]);
    removeSource(1);
    removeSource(2);
    removeSource(4);
    expect(getSources().open).toBe(false);
    expect(getSources().items).toEqual([]);
    // 历史重开同一会话的架子：叉过的网址仍不露面（页面级隐藏表）
    openSources('s1', [item(1), item(5)]);
    expect(getSources().items.map((s) => s.n)).toEqual([5]);
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
