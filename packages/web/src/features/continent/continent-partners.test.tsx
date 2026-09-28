// @vitest-environment jsdom
/**
 * continent-partners.test — 伙伴的**取数与写口**（契约 `docs/NPC-PARTNER-SPEC.md` §7）。
 *
 * ★ 为什么单独一个文件、又为什么直接测 hook：`ContinentPage.test.tsx` 要守 gates 的「.tsx ≤300 行」
 *   红线（它已 299 行），而本次新增的"选位态 + 创建"是一族新行为。测 hook 比再渲染一遍整页便宜，
 *   锁的也更准——本次最容易烂掉的三件事都在这几个回调里：
 *   ① **不能创建时必须说清为什么**（`blockedBy` 原样说出去，禁静默）；
 *   ② **创建成功要说真话**（`source='fallback'` 时补一句"名字是本地起的"）；
 *   ③ **失败留在选位态**（换一格再点就好），且服务端那句话原样透给用户（不许换成"创建失败"）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const npcMock = {
  state: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  // 伙伴会游走那次改动新增：心跳与气泡。默认回"没人想说话"，
  // 免得每个既有用例都要处理轮询（轮询本身另有专门用例）
  ping: vi.fn(async () => ({ bubble: null, npcs: [] })),
  dismissBubble: vi.fn(async () => ({ ok: true as const })),
};
const cardsMock = { state: vi.fn() };
vi.mock('../../lib/api', () => ({ api: { npc: npcMock, cards: cardsMock } }));

const { useContinentPartners } = await import('./continent-partners');

/** 一份中性状态：还没有伙伴、第一位无条件可创建、有一格能站 */
function stateOf(over: Record<string, unknown> = {}) {
  return {
    partnerName: '',
    npcs: [],
    tradesLeft: 2,
    quota: { count: 0, max: 6, doneTasks: 0, needTasks: 0, canCreate: true, blockedBy: '' },
    spots: [{ row: 5, col: 7 }],
    cells: [{ termId: 't1', term: '主动回忆', domain: '记忆机制', row: 5, col: 7 }],
    ...over,
  };
}

const oneNpc = {
  id: 'npc:t1',
  name: '阿问',
  bio: '守着「主动回忆」的伙伴',
  termId: 't1',
  term: '主动回忆',
  domain: '记忆机制',
  row: 5,
  col: 7,
  homeRow: 5,
  homeCol: 7,
  distressed: false,
  threat: null,
};

async function mount() {
  const onNotice = vi.fn();
  const view = renderHook(() => useContinentPartners(onNotice));
  await act(async () => {
    await view.result.current.refresh();
  });
  return { view, onNotice };
}

beforeEach(() => {
  cardsMock.state.mockResolvedValue({ wall: [] });
  npcMock.state.mockResolvedValue(stateOf());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useContinentPartners · 取数', () => {
  it('① 两个只读口并发读一次；信物只留 `cards>=2` 的那些（卡数也是服务端读数）', async () => {
    cardsMock.state.mockResolvedValue({
      wall: [
        { termId: 'a', term: '甲', card: { cards: 1 } },
        { termId: 'b', term: '乙', card: { cards: 3 } },
      ],
    });
    const { view } = await mount();
    expect(npcMock.state).toHaveBeenCalledTimes(1);
    expect(cardsMock.state).toHaveBeenCalledTimes(1);
    expect(view.result.current.tokens.map((t) => t.termId)).toEqual(['b']);
    expect(view.result.current.partners?.tradesLeft).toBe(2);
    expect(view.result.current.partners?.spots).toEqual([{ row: 5, col: 7 }]);
  });
});

describe('useContinentPartners · 创建（选位态）', () => {
  it('② 不能创建 ⇒ 只把 `blockedBy` 说出来，**不进**选位态（钮灰着也要说清为什么）', async () => {
    npcMock.state.mockResolvedValue(
      stateOf({
        quota: { count: 1, max: 6, doneTasks: 0, needTasks: 3, canCreate: false, blockedBy: '还差 3 单任务，就能再创建一位伙伴。' },
      }),
    );
    const { view, onNotice } = await mount();
    act(() => view.result.current.startCreate());
    expect(onNotice).toHaveBeenCalledWith('还差 3 单任务，就能再创建一位伙伴。');
    expect(view.result.current.placing).toBe(false);
    expect(view.result.current.placeSpots).toBeUndefined();
  });

  it('②b 能创建 ⇒ 进选位态，并把**可落位格**交给地图（绿框高亮靠它）', async () => {
    const { view, onNotice } = await mount();
    act(() => view.result.current.startCreate());
    expect(view.result.current.placing).toBe(true);
    expect(view.result.current.placeSpots).toEqual([{ row: 5, col: 7 }]);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('点地图上一格'));
    act(() => view.result.current.cancelCreate());
    expect(view.result.current.placing).toBe(false);
  });

  it('③ 创建成功 ⇒ 退出选位态 + 换上新状态；`fallback` 时补一句"名字是本地起的"（降级说真话）', async () => {
    npcMock.create.mockResolvedValue({
      state: stateOf({
        npcs: [oneNpc],
        partnerName: '阿问',
        quota: { count: 1, max: 6, doneTasks: 0, needTasks: 3, canCreate: false, blockedBy: '还差 3 单任务，就能再创建一位伙伴。' },
      }),
      memberId: 'npc:t1',
      source: 'fallback',
    });
    const { view, onNotice } = await mount();
    act(() => view.result.current.startCreate());
    await act(async () => {
      await view.result.current.placeAt(5, 7);
    });
    expect(npcMock.create).toHaveBeenCalledWith(5, 7);
    expect(view.result.current.placing).toBe(false);
    expect(view.result.current.partners?.npcs).toHaveLength(1);
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('「阿问」来了——守着「主动回忆」的伙伴'));
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('名字是本地起的'));
  });

  it('③b 名字是 AI 起的时**不多嘴**提"本地起的"（只在该说的时候说）', async () => {
    npcMock.create.mockResolvedValue({
      state: stateOf({ npcs: [oneNpc], partnerName: '阿问' }),
      memberId: 'npc:t1',
      source: 'ai',
    });
    const { view, onNotice } = await mount();
    act(() => view.result.current.startCreate());
    await act(async () => {
      await view.result.current.placeAt(5, 7);
    });
    const said = onNotice.mock.calls.map((c) => String(c[0])).join('|');
    expect(said).toContain('「阿问」来了');
    expect(said).not.toContain('本地起了');
  });

  it('④ 失败 ⇒ **留在选位态**，且把服务端那句话原样说出来（不许换成"创建失败"）', async () => {
    npcMock.create.mockRejectedValue(new Error('这一格被「间隔重复」的怪占着——先把怪清掉，再安置伙伴。'));
    const { view, onNotice } = await mount();
    act(() => view.result.current.startCreate());
    await act(async () => {
      await view.result.current.placeAt(5, 7);
    });
    expect(onNotice).toHaveBeenCalledWith('这一格被「间隔重复」的怪占着——先把怪清掉，再安置伙伴。');
    expect(view.result.current.placing).toBe(true);
  });
});

describe('useContinentPartners · 改名与解散', () => {
  it('⑤ 改名与解散都把**整份新状态**换上（解散会空出一格，只回"成功"地图就过期了）', async () => {
    npcMock.state.mockResolvedValue(stateOf({ npcs: [oneNpc], partnerName: '阿问' }));
    const { view } = await mount();
    npcMock.rename.mockResolvedValue({ state: stateOf({ npcs: [{ ...oneNpc, name: '小满' }], partnerName: '小满' }) });
    let named = '';
    await act(async () => {
      named = await view.result.current.rename('npc:t1', '小满');
    });
    expect(named).toBe('小满');
    expect(view.result.current.partners?.npcs[0]?.name).toBe('小满');

    npcMock.remove.mockResolvedValue({ state: stateOf() });
    await act(async () => {
      await view.result.current.remove('npc:t1');
    });
    expect(view.result.current.partners?.npcs).toEqual([]);
    expect(view.result.current.partners?.spots).toEqual([{ row: 5, col: 7 }]);
  });
});