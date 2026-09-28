// @vitest-environment jsdom
/**
 * continent-ember — 余烬笺在大陆上的呈现：揭开后的笺（署名 / 收入卡册 / 致谢）与地块详情里的写笺。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react';

const emberMock = vi.hoisted(() => ({
  mine: vi.fn(async () => ({ notes: [] as unknown[] })),
  write: vi.fn(async (_id: string, body: string, sign?: string) => ({
    note: { id: 'n1', term: '费曼学习法', domain: '学习方法', definition: '', body, sign: sign ?? '无名旅人', hue: 'cyan', thanks: 0, createdAt: '2026-09-28' },
  })),
}));
vi.mock('../../lib/api', () => ({ api: { ember: emberMock } }));

const { EmberDialog, TileDetail } = await import('./continent-ember');

afterEach(cleanup);

const spot = {
  row: 1, col: 2, kept: false, thanked: false,
  note: { id: 'e1', term: '机会成本', domain: '经济学', definition: '', body: '那局排位就是我的机会成本。', sign: '北坡的石头', hue: 'gold', thanks: 2, createdAt: '2026-09-27 10:00:00' },
};

describe('余烬笺 · 大陆呈现', () => {
  it('揭开的笺带作者署名与致谢数，三个动作各自回调', async () => {
    const onKeep = vi.fn(async () => undefined);
    const onThank = vi.fn(async () => undefined);
    const { getByText, container } = render(<EmberDialog spot={spot} onKeep={onKeep} onThank={onThank} onHide={vi.fn(async () => undefined)} onClose={() => undefined} />);
    expect(container.querySelector('.continent-ember-sign')?.textContent).toContain('北坡的石头');
    expect(container.textContent).toContain('已有 2 人添柴');
    fireEvent.click(getByText('收入卡册'));
    await waitFor(() => expect(onKeep).toHaveBeenCalled());
    fireEvent.click(getByText('添一根柴（致谢）'));
    await waitFor(() => expect(onThank).toHaveBeenCalled());
  });

  it('地块详情可以写一张余烬笺（带署名），写下前明示会公开', async () => {
    const tile = { id: 't1', term: '费曼学习法', domain: '学习方法', definition: '用教别人检验理解' } as never;
    const onNotice = vi.fn();
    const { getByText, getByPlaceholderText, container } = render(<TileDetail tile={tile} onClose={() => undefined} onNotice={onNotice} />);
    fireEvent.click(getByText('留一张余烬笺'));
    expect(container.textContent).toContain('同意公开');
    fireEvent.change(container.querySelector('textarea')!, { target: { value: '讲给奶奶听，讲不出来的地方就是没懂的地方。' } });
    fireEvent.change(getByPlaceholderText('署名（留空则用昵称）'), { target: { value: '夜读的阿柚' } });
    fireEvent.click(getByText('点燃余烬笺'));
    await waitFor(() => expect(emberMock.write).toHaveBeenCalledWith('t1', '讲给奶奶听，讲不出来的地方就是没懂的地方。', '夜读的阿柚'));
    await waitFor(() => expect(container.textContent).toContain('你的余烬笺'));
  });
});
