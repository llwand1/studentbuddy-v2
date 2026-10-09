// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ComposerRequests } from '../features/chat/ComposerRequests';
import { ComposerDock } from '../features/chat/ComposerDock';
import { ReadingSplit } from './ReadingSplit';
import { useMobilePanel } from '../lib/use-mobile-panel';
import { applyLiveSources, getSources, reopenSources, resetSourcesStore } from '../lib/sources-store';
import { closePreview } from '../lib/preview-store';
import type { AskChoiceRecord } from '@sb/shared';

const width = vi.hoisted(() => ({ narrow: true }));
vi.mock('../lib/use-narrow', () => ({ useNarrow: () => width.narrow, readNarrow: () => width.narrow }));
beforeEach(() => { width.narrow = true; localStorage.clear(); resetSourcesStore(); closePreview(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('手机确认与选择共用入口，不自动批准；切卡与收起保留自定义草稿，超时结果如实可读', () => {
  const reply = vi.fn();
  const request: AskChoiceRecord = { id: 'choice1', sessionId: 's1', question: '接着练什么？', options: [{ id: 'a', label: '受力分析' }], allowCustom: true, multi: false, ts: 1, status: 'pending', reply: null, answeredAt: null };
  const confirm = { request: { requestId: 'confirm1', tool: 'delete_terms', source: 'builtin' as const, actionSummary: '删除两条重复词条', affected: 2, items: ['重复词条一', '重复词条二'], expiresAt: 60000, decision: null }, now: 1000, onReply: reply, onDismiss: vi.fn() };
  const choice = { request, onReply: vi.fn(), onDismiss: vi.fn() };
  const view = render(<ComposerRequests ask={null} confirm={confirm} choice={choice} />);
  const entry = screen.getByRole('button', { name: /等待确认 · 2/ });
  expect(entry.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: '允许这一次' })).toBeNull();
  expect(reply).not.toHaveBeenCalled();
  fireEvent.click(entry);
  fireEvent.click(screen.getByRole('button', { name: '等待选择' }));
  fireEvent.click(screen.getByRole('button', { name: /以上都不是/ }));
  fireEvent.change(screen.getByPlaceholderText('写出你的口径，AI 会按它继续…'), { target: { value: '先讲加速度' } });
  fireEvent.click(screen.getByRole('button', { name: '等待确认' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '允许这一次' }));
  expect(reply).toHaveBeenCalledWith('confirm1', 'allow_once');
  fireEvent.click(entry); fireEvent.click(entry);
  fireEvent.click(screen.getByRole('button', { name: '等待选择' }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('先讲加速度');
  view.rerender(<ComposerRequests ask={null} confirm={{ ...confirm, request: { ...confirm.request, decision: 'timeout' } }} choice={choice} />);
  fireEvent.click(screen.getByRole('button', { name: '确认结果' }));
  expect(screen.getByText(/60 秒未确认，已按拒绝处理/)).toBeTruthy();
});

it('输入区收起保留 DOM 和草稿，生成中仍可停止，展开恢复原输入', () => {
  const stop = vi.fn();
  render(<ComposerDock busy draft onStop={stop}><textarea aria-label="输入" defaultValue="我的草稿" /></ComposerDock>);
  const input = screen.getByLabelText('输入');
  fireEvent.click(screen.getByRole('button', { name: '收起输入' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(input.isConnected).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
  expect(stop).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '展开输入 · 有草稿' }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('我的草稿');
});

it('资料分界线按设备记住比例，键盘可调且有上下限，调整不改资料选择', () => {
  applyLiveSources({ kind: 'sources', sessionId: 's1', items: [{ n: 2, title: '受力分析', url: 'https://example.com', site: 'example.com', kind: 'page', origin: 'read' }] });
  reopenSources();
  const view = render(<section><ReadingSplit /></section>);
  const divider = screen.getByRole('separator');
  expect(divider.getAttribute('aria-orientation')).toBe('horizontal');
  fireEvent.keyDown(divider, { key: 'ArrowDown' });
  expect(divider.parentElement?.style.getPropertyValue('--reading-share')).toBe('55%');
  expect(localStorage.getItem('sb:reading:share:mobile')).toBe('55');
  expect(getSources().activeN).toBe(2);
  width.narrow = false; view.rerender(<section><ReadingSplit /></section>);
  expect(divider.getAttribute('aria-orientation')).toBe('vertical');
  expect(divider.getAttribute('aria-valuenow')).toBe('40');
  for (let i = 0; i < 20; i++) fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  expect(divider.getAttribute('aria-valuenow')).toBe('80');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('denied'); });
  expect(() => fireEvent.keyDown(divider, { key: 'Home' })).not.toThrow();
  expect(divider.getAttribute('aria-valuenow')).toBe('40');
});

function Panel({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  useMobilePanel(open, () => setOpen(false));
  return <button onClick={() => setOpen(true)} aria-expanded={open}>{name}</button>;
}
it('手机手动工具只保留一个前台；桌面仍可并排使用', () => {
  render(<><Panel name="引路灯" /><Panel name="复习督促" /></>);
  fireEvent.click(screen.getByText('引路灯'));
  fireEvent.click(screen.getByText('复习督促'));
  expect(screen.getByText('引路灯').getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByText('复习督促').getAttribute('aria-expanded')).toBe('true');
  act(() => { width.narrow = false; });
  fireEvent.click(screen.getByText('引路灯'));
  expect(screen.getByText('复习督促').getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('引路灯').getAttribute('aria-expanded')).toBe('true');
});
