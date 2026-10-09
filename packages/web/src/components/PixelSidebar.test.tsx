// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PixelSidebar } from './PixelSidebar';
import { useReadingLayout } from '../app/useReadingLayout';
import { ReadingToolbar } from '../app/ReadingToolbar';
import { applyLiveSources, closeSources, getSources, resetSourcesStore } from '../lib/sources-store';
import { closePreview, getPreview, openPreview } from '../lib/preview-store';

beforeEach(() => { localStorage.clear(); resetSourcesStore(); closePreview(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function ReadingProbe({ sessionId = 's1' }: { sessionId?: string }) {
  const layout = useReadingLayout();
  return <div className={layout.focused ? 'is-reading-focus' : ''}>
    <PixelSidebar collapsed={layout.collapsed}><input aria-label="搜索历史" /></PixelSidebar>
    <ReadingToolbar layout={layout} sessionId={sessionId}><span>引路灯</span></ReadingToolbar>
  </div>;
}
describe('responsive pixel navigation', () => {
  it('declares the drawer relationship and toggles it without losing children', () => {
    render(<PixelSidebar><input aria-label="搜索历史" /></PixelSidebar>);
    const toggle = screen.getByRole('button', { name: '探索菜单' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('sb-sidebar-content');
    fireEvent.change(screen.getByLabelText('搜索历史'), { target: { value: '向量' } });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect((screen.getByLabelText('搜索历史') as HTMLInputElement).value).toBe('向量');
  });
  it('Escape and the backdrop dismiss the drawer and restore keyboard focus', () => {
    render(<PixelSidebar><button>历史记录</button></PixelSidebar>);
    const toggle = screen.getByRole('button', { name: '探索菜单' });
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByRole('button', { name: '历史记录' }), { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: '关闭导航' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
  it('selecting a destination closes the drawer and still invokes navigation', () => {
    const navigate = vi.fn();
    render(<PixelSidebar><button className="sb-nav-item" onClick={navigate}><span>词条</span></button></PixelSidebar>);
    const toggle = screen.getByRole('button', { name: '探索菜单' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('词条'));
    expect(navigate).toHaveBeenCalledOnce();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
  it('account forms and history search do not dismiss the navigation', () => {
    render(<PixelSidebar><button>历史对话</button><input aria-label="邮箱" /></PixelSidebar>);
    const toggle = screen.getByRole('button', { name: '探索菜单' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByLabelText('邮箱'));
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('reading layout', () => {
  it('folding preserves mounted navigation state and remembers the preference after reopening the app', () => {
    const first = render(<ReadingProbe />);
    fireEvent.change(screen.getByLabelText('搜索历史'), { target: { value: '向量' } });
    fireEvent.click(screen.getByRole('button', { name: '收起导航' }));
    expect(first.container.querySelector('.sb-sidebar.is-collapsed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开导航' }));
    expect((screen.getByLabelText('搜索历史') as HTMLInputElement).value).toBe('向量');
    fireEvent.click(screen.getByRole('button', { name: '收起导航' }));
    first.unmount();
    render(<ReadingProbe />);
    expect(screen.getByRole('button', { name: '展开导航' }).getAttribute('aria-expanded')).toBe('false');
  });
  it('temporary focus restores the previous sidebar choice and opening navigation leaves focus', () => {
    render(<ReadingProbe />);
    fireEvent.click(screen.getByRole('button', { name: '专注阅读' }));
    expect(screen.getByRole('button', { name: '退出专注' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '退出专注' }));
    expect(screen.getByRole('button', { name: '收起导航' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起导航' }));
    fireEvent.click(screen.getByRole('button', { name: '专注阅读' }));
    fireEvent.click(screen.getByRole('button', { name: '退出专注' }));
    expect(screen.getByRole('button', { name: '展开导航' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '专注阅读' }));
    fireEvent.click(screen.getByRole('button', { name: '展开导航' }));
    expect(screen.getByRole('button', { name: '专注阅读' })).toBeTruthy();
  });
  it('the source entry is session scoped and explicitly reopens live sources without losing selection', () => {
    applyLiveSources({ kind: 'sources', sessionId: 's1', readingN: 2, items: [
      { n: 2, title: '向量', url: 'https://example.com/vector', site: 'example.com', kind: 'page', origin: 'read' },
    ] });
    const { rerender } = render(<ReadingProbe />);
    expect(getSources().open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '资料 1' }));
    expect(getSources()).toMatchObject({ open: true, activeN: 2, readingN: 2, live: true });
    openPreview('/api/preview/qa', '演示');
    rerender(<ReadingProbe />);
    fireEvent.click(screen.getByRole('button', { name: '资料 1' }));
    expect(getPreview()).toBeNull();
    expect(getSources().open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '资料 1' }));
    expect(getSources().open).toBe(false);
    closeSources();
    rerender(<ReadingProbe sessionId="s2" />);
    expect(screen.queryByRole('button', { name: '资料 1' })).toBeNull();
  });
  it('navigation remains usable when browser storage rejects writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    render(<ReadingProbe />);
    fireEvent.click(screen.getByRole('button', { name: '收起导航' }));
    expect(screen.getByRole('button', { name: '展开导航' })).toBeTruthy();
  });
});
