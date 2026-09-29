// @vitest-environment jsdom
/**
 * TermRelations — 关联列表：有边列出中文说法、空态说明来源、失败提示。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const relations = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api-ai-ops', () => ({ aiOpsApi: { relations } }));
const { TermRelations } = await import('./TermRelations');

afterEach(() => {
  cleanup();
  relations.mockReset();
});

describe('TermRelations', () => {
  it('列出关系的中文说法与词名，note 作悬停提示', async () => {
    relations.mockResolvedValue({ items: [
      { termId: 'a', term: '光反应', relation: 'prerequisite', outgoing: false, label: '需要先懂', note: '提供 ATP' },
      { termId: 'b', term: '有丝分裂', relation: 'contrast', outgoing: true, label: '易混淆', note: '' },
    ] });
    render(<TermRelations termId="t1" />);
    expect(await screen.findByText('光反应')).toBeTruthy();
    expect(screen.getByText('需要先懂')).toBeTruthy();
    expect(screen.getByText('光反应').closest('li')?.getAttribute('title')).toBe('提供 ATP');
    expect(relations).toHaveBeenCalledWith('t1');
  });
  it('没有关联 ⇒ 说明会由 AI 后台整理', async () => {
    relations.mockResolvedValue({ items: [] });
    render(<TermRelations termId="t1" />);
    expect(await screen.findByText(/AI 会在后台/)).toBeTruthy();
  });
  it('失败 ⇒ 提示', async () => {
    relations.mockRejectedValue(new Error('x'));
    render(<TermRelations termId="t1" />);
    expect(await screen.findByText('关联读取失败，稍后再试')).toBeTruthy();
  });
});
