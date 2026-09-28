// @vitest-environment jsdom
/**
 * features/continent/NpcDialog.test — 伙伴对话面板的两句**必须说出来的真话**（契约 §4.2／§6.3）。
 *
 * 这两条都不是"渲染出来了"，而是**降级与门槛必须被用户看见**：
 *  ① 无 key 时伙伴走本地台词 ⇒ 面板必须说「靠固定台词应答」并给出绑定指引。
 *     不说这句，用户会以为 AI 就是这么木——恰好把"AI 含量少"的观感钉死，与立项理由相反。
 *  ② 交换有信物门槛（★1 以上 / 至少 2 张卡）⇒ 拿不出信物时按钮必须**禁用**，并说清门槛；
 *     按钮可点却必然报错，比按钮灰着更伤人。
 * ★ 这里**不测"聊天内容好不好"**（那是模型的事），也不测收下流程（`RitualOverlay` 已有自己的用例）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NPC_FALLBACK_NOTICE } from '@sb/shared';
import type { NpcView } from '../../lib/api-npc';

const apiMock = { talk: vi.fn(), trade: vi.fn(), rename: vi.fn(), remove: vi.fn(), state: vi.fn() };
const cardsMock = { acceptDraw: vi.fn() };
vi.mock('../../lib/api', () => ({ api: { npc: apiMock } }));
vi.mock('../../lib/api-cards', () => ({ cardsApi: cardsMock }));

const { NpcDialog } = await import('./NpcDialog');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** 一位健健康康的伙伴（遇险形态另有 `threat`，本文件不需要） */
function npcOf(over: Partial<NpcView> = {}): NpcView {
  return {
    id: 'npc:t1',
    name: '小满',
    bio: '守着「主动回忆」的老手',
    termId: 't1',
    term: '主动回忆',
    domain: '记忆机制',
    row: 5,
    col: 7,
    homeRow: 5,
    homeCol: 7,
    distressed: false,
    threat: null,
    ...over,
  };
}

function open(props: Partial<Parameters<typeof NpcDialog>[0]> = {}) {
  return render(
    <NpcDialog
      npc={npcOf()}
      tokens={[{ termId: 't9', term: '我的信物', cards: 3 }]}
      tradesLeft={2}
      onRename={vi.fn().mockResolvedValue(undefined)}
      onRemove={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn()}
      onRescue={vi.fn()}
      onLibraryChanged={vi.fn()}
      {...props}
    />,
  );
}

describe('学习伙伴对话面板', () => {
  it('① 降级时说真话：显示「靠固定台词应答」并给设置指引', async () => {
    apiMock.talk.mockResolvedValue({ reply: '我在这片守「主动回忆」呢。', source: 'fallback' });
    open();

    fireEvent.change(screen.getByLabelText('对伙伴说的话'), { target: { value: '你在干嘛' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(screen.getByText(/我在这片守「主动回忆」呢。/)).toBeTruthy());
    // ★ 这两段是同一个常量的两半：既说了"这是固定台词"，也说了"去哪绑模型"
    expect(NPC_FALLBACK_NOTICE).toContain('靠固定台词应答');
    expect(NPC_FALLBACK_NOTICE).toContain('设置');
    expect(screen.getByText(NPC_FALLBACK_NOTICE)).toBeTruthy();
  });

  it('② 没有能当信物的词条 ⇒ 交换按钮禁用，且文案把门槛（★1／2 张）说出来', () => {
    open({ tokens: [] });
    const button = screen.getByRole('button', { name: '换一条新词' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/要 ★1 以上（至少 2 张卡）/)).toBeTruthy();
    // ★ 代价那句话必须在场，且不许被改写成"消耗一张卡"
    expect(screen.getByText(/卡本身不会少/)).toBeTruthy();
    expect(apiMock.trade).not.toHaveBeenCalled();
  });

  it('③ 人设显示在标题旁；「让他回家」两段式：第一下只上膛，第二下才真的送走', async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    open({ onRemove, onClose });
    expect(screen.getByText(/守着「主动回忆」的老手/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '让他回家' }));
    // ★ 一个不可撤销的动作不该一键就发生（上膛态只改文案，不调服务端）
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认送他回家' }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});