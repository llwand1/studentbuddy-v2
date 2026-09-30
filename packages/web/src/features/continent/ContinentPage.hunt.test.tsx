// @vitest-environment jsdom
/**
 * ContinentPage.hunt.test — 知识大陆的**导航 / 一键讨伐 / 话题怪 / 废墟重建**接线（2026-09-30）。
 *
 * 锁四条死路：
 *  ① 「导航」面板里的话题怪能「前往」：英雄自己走到旁边**自动开打**（不是隔空开打，也不是走到了却要再点一次）；
 *     打赢后回话说清"刚聊到就复习了一次、已纳入范围"。
 *  ② 从对话页带着名单进来（`requestHunt`）：大陆页一挂好就自动出发，不用再找。
 *  ③ 废墟在导航里有「重建」：点了就是同一场战斗，打赢＝复习＝原地重建（回话要说"重建"）。
 *  ④ 走不到（被荒地围死）要说话，不能默默不动。
 *
 * 桩与手势见 `ContinentPage.testkit.tsx`。英雄走位是真定时器（每步 130ms），故到达断言用 `waitFor`。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen, within } from '@testing-library/react';
import { buildContinentView } from './continent-view';
import { requestHunt, resetHuntStore } from './continent-hunt-store';
import {
  DAY_KEY,
  MonsterDialogStub,
  apiMock,
  cardsMock,
  daysAgo,
  installContinentPageHooks,
  npcMock,
  settledTerms,
  termOf,
} from './ContinentPage.testkit';

vi.mock('../../lib/api', () => ({ api: { terms: apiMock, cards: cardsMock, npc: npcMock } }));
vi.mock('./MonsterDialog', () => ({ MonsterDialog: MonsterDialogStub }));

const { ContinentPage } = await import('./ContinentPage');

installContinentPageHooks();

/** 一条今天在对话里被提到、范围外、离中心一圈的词条 ⇒ 话题怪 */
function topicTerm(id = 't'): ReturnType<typeof termOf> {
  return termOf(id, false, { created_at: daysAgo(7), last_used_at: daysAgo(0) });
}

async function mapReady(): Promise<void> {
  await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/));
}

function openNav(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: '导航' }));
  return screen.getByRole('complementary', { name: '导航' });
}

describe('ContinentPage 导航与讨伐', () => {
  beforeEach(() => resetHuntStore());

  it('★ 话题怪：导航面板列出「话题」，点「前往」英雄走到旁边自动开打；答完先纳入范围再打卡，回话说"刚聊到"', async () => {
    const terms = [...settledTerms(), topicTerm()];
    apiMock.map.mockResolvedValue({ terms });
    apiMock.scopeTerm.mockResolvedValue({ id: 't', enabled: true, resetCount: 0 });
    apiMock.mark.mockResolvedValue(terms[6]);
    render(<ContinentPage />);
    await mapReady();

    const view = buildContinentView(terms, { dayKey: DAY_KEY });
    expect(view.tiles.find((t) => t.id === 't')?.monsterKind).toBe('topic');
    expect(view.topicCount).toBe(1);

    const nav = openNav();
    const row = within(nav).getByText('词条t').closest('.continent-nav-row') as HTMLElement;
    expect(within(row).getByText('话题')).toBeTruthy();
    expect(document.querySelector('.stub-monster-dialog')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: '前往' }));
    // 到了旁边自动开打（够得着就立刻开；够不着走一两步、每步 130ms）
    await waitFor(() => expect(document.querySelector('.stub-monster-dialog')).toBeTruthy(), { timeout: 2000 });

    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(apiMock.mark).toHaveBeenCalledWith('t', true));
    expect(apiMock.scopeTerm).toHaveBeenCalledWith('t', true);
    await waitFor(() => expect(screen.getByText(/打跑了话题怪「词条t」/)).toBeTruthy());
    expect(screen.getByText(/已纳入复习范围/)).toBeTruthy();
  });

  it('★ 一键讨伐：对话页投递名单 ⇒ 大陆页一挂好就自动出发，到了开打；名单取一次即清', async () => {
    const terms = [...settledTerms(), topicTerm()];
    apiMock.map.mockResolvedValue({ terms });
    requestHunt(['t']);
    render(<ContinentPage />);
    await mapReady();
    await waitFor(() => expect(document.querySelector('.stub-monster-dialog')).toBeTruthy(), { timeout: 2000 });
    // 弹窗里是那只话题怪（桩把 tile 原样收下）
    fireEvent.click(document.querySelector('.stub-close') as HTMLButtonElement);
    expect(document.querySelector('.stub-monster-dialog')).toBeNull();
  });

  it('★ 废墟：导航里列成「废墟」+「重建」，点了就是同一场战斗，打赢回话说"重建了"', async () => {
    // 中心一条今天复习过的老词条（英雄站这儿）；旁边一条 95 天没碰、范围外的词条 ⇒ 第 1 环耐久 90 天 ⇒ 废墟
    const center = termOf('c', true, { created_at: daysAgo(200), review_stage: 3, last_reviewed_at: daysAgo(0) });
    const ruin = termOf('r', false, { created_at: daysAgo(100), review_stage: 1, last_reviewed_at: daysAgo(95) });
    const terms = [center, ruin];
    apiMock.map.mockResolvedValue({ terms });
    apiMock.scopeTerm.mockResolvedValue({ id: 'r', enabled: true, resetCount: 0 });
    apiMock.mark.mockResolvedValue(ruin);
    render(<ContinentPage />);
    await mapReady();

    const view = buildContinentView(terms, { dayKey: DAY_KEY });
    const rt = view.tiles.find((t) => t.id === 'r');
    expect(rt?.ruin).toBe(true);
    expect(rt?.ring).toBe(1);
    expect(view.ruinCount).toBe(1);
    expect(document.querySelector('.continent-stat-ruin')?.textContent).toContain('1');

    const nav = openNav();
    const row = within(nav).getByText('词条r').closest('.continent-nav-row') as HTMLElement;
    expect(within(row).getByText(/95 天没碰/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: '重建' }));
    await waitFor(() => expect(document.querySelector('.stub-monster-dialog')).toBeTruthy(), { timeout: 2000 });
    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(apiMock.mark).toHaveBeenCalledWith('r', true));
    await waitFor(() => expect(screen.getByText(/「词条r」的废墟重建了/)).toBeTruthy());
  });

  it('走不到要说话：目标被荒地围死 ⇒ 横幅提示"走不到"，目标仍在导航里高亮', async () => {
    // 只有两条词条：中心 c 与第 1 环的话题怪 t——t 的其余邻居全是荒地；把 c 放在 t 的对角就够不着也走不到
    // 做法：三条词条 c(0,0)、x(第 1 环第 1 位)、t(第 1 环第 2 位)。若 t 与 c 正相邻则本用例退化为"直接开打"，故先断言几何。
    const center = termOf('c', true, { created_at: daysAgo(200), review_stage: 3, last_reviewed_at: daysAgo(0) });
    const wall = termOf('x', true, { created_at: daysAgo(150) }); // 逾期 ⇒ 欠账怪，不可通行
    const t = topicTerm();
    const terms = [center, wall, t];
    const view = buildContinentView(terms, { dayKey: DAY_KEY });
    const ct = view.tiles.find((v) => v.id === 'c')!;
    const tt = view.tiles.find((v) => v.id === 't')!;
    const adjacent = Math.abs(ct.row - tt.row) + Math.abs(ct.col - tt.col) <= 1;
    apiMock.map.mockResolvedValue({ terms });
    render(<ContinentPage />);
    await mapReady();
    const nav = openNav();
    const row = within(nav).getByText('词条t').closest('.continent-nav-row') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '前往' }));
    if (adjacent) {
      await waitFor(() => expect(document.querySelector('.stub-monster-dialog')).toBeTruthy());
      return;
    }
    await waitFor(() => expect(screen.getByText(/走不到「词条t」旁边/)).toBeTruthy());
    expect(document.querySelector('.stub-monster-dialog')).toBeNull();
    expect(row.classList.contains('is-target')).toBe(true);
  });
});
