// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PixelSidebar } from './PixelSidebar';

afterEach(cleanup);
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
