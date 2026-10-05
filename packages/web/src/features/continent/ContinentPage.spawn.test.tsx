// @vitest-environment jsdom
/**
 * ContinentPage.spawn.test — 知识大陆页上两个新入口的接线（2026-09-29）：**野怪**与**边界「+」**。
 *
 * 锁两条死路：
 *  ① 新用户（唯一一条范围外的新词条）图上必须有怪；答完要**先纳入范围再打卡**（范围外直接 mark 必 409），
 *     回话要说清"提前复习、已纳入范围"——否则用户不知道自己刚才改了复习范围。
 *  ② 点边界空格要开**开拓弹窗**并按点的坐标领地；词池兜底的来源必须如实写出来。
 *
 * 桩与手势见 `ContinentPage.testkit.tsx`（与 `ContinentPage.test.tsx` 共用）。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';
import { buildContinentView } from './continent-view';
import {
  CENTER_COL,
  CENTER_ROW,
  DAY_KEY,
  MonsterDialogStub,
  apiMock,
  cardsMock,
  clickCell,
  clickWorld,
  daysAgo,
  installContinentPageHooks,
  npcMock,
  termOf,
} from './ContinentPage.testkit';

vi.mock('../../lib/api', () => ({ api: { terms: apiMock, cards: cardsMock, npc: npcMock } }));
vi.mock('./MonsterDialog', () => ({ MonsterDialog: MonsterDialogStub }));

const { ContinentPage } = await import('./ContinentPage');

installContinentPageHooks();

describe('ContinentPage 野怪与开拓', () => {
  it('★ 野怪：新用户唯一一条范围外的新词条也会冒怪；答完先纳入范围再打卡，回话说明"提前复习"', async () => {
    // 今天刚存的一条词条：不在范围内、没到期 ⇒ 旧口径下地图上什么都没有；新口径下它是今天的野怪位
    const fresh = termOf('n1', false, { created_at: daysAgo(0) });
    apiMock.map.mockResolvedValue({ terms: [fresh] });
    apiMock.scopeTerm.mockResolvedValue({ id: 'n1', enabled: true, resetCount: 0 });
    apiMock.mark.mockResolvedValue(fresh);
    render(<ContinentPage />);
    await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/));

    const view = buildContinentView([fresh], { dayKey: DAY_KEY });
    expect(view.wildCount).toBe(1);
    expect(view.monsterCount).toBe(0); // 不是欠账怪
    expect(screen.getByText('野怪')).toBeTruthy();

    // ★ 全量并发下这一笔常落在「上一帧已提交的树」上（React 18 并发渲染 + fireEvent 同步派发），
    //   于是走位/详情分支被触发而弹窗永不出——2026-10-05 CI 与本机 metrics 路径各复现一次，
    //   同族脆弱本文件 2026-10-02 登记过。处置照既定口径：**等它、重试那一下点击，不删例、不放宽判据**。
    await waitFor(
      () => {
        if (document.querySelector('.stub-monster-dialog')) return;
        clickCell(CENTER_ROW, CENTER_COL);
        expect(document.querySelector('.stub-monster-dialog')).toBeTruthy();
      },
      { timeout: 4000, interval: 40 },
    );
    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    // ★ 先纳入复习范围、再打卡（范围外直接 mark 必 409）；两步都发生，且顺序正确
    await waitFor(() => expect(apiMock.mark).toHaveBeenCalledWith('n1', true));
    expect(apiMock.scopeTerm).toHaveBeenCalledWith('n1', true);
    expect(apiMock.scopeTerm.mock.invocationCallOrder[0]).toBeLessThan(apiMock.mark.mock.invocationCallOrder[0] ?? 0);
    await waitFor(() => expect(screen.getByText(/打跑了野怪「词条n1」/)).toBeTruthy());
    expect(screen.getByText(/已纳入复习范围/)).toBeTruthy();
  });

  it('★ 边界上的「+」：点空的边界格 → 开拓弹窗领地（offer 带着点的坐标）', async () => {
    const terms = [termOf('a', true, { review_stage: 1, last_reviewed_at: daysAgo(0) })];
    apiMock.map.mockResolvedValue({ terms, pins: [] });
    apiMock.expandOffer.mockResolvedValue({
      nonce: 'x', row: 0, col: 1, term: '新词', definition: '新释义', domain: 'js', source: 'fallback',
      fallbackReason: '没有绑定可用的模型，这条来自内置词池', questions: [], expiresAt: Date.now() + 60_000,
    });
    render(<ContinentPage />);
    await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/));

    const view = buildContinentView(terms, { dayKey: DAY_KEY });
    // 单条词条在 (0,0)，它的四邻都是边界空格
    expect(view.frontier).toEqual(expect.arrayContaining([{ row: 0, col: 1 }, { row: 1, col: 0 }]));
    clickWorld(view, 0, 1);
    await waitFor(() => expect(apiMock.expandOffer).toHaveBeenCalledWith(0, 1));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '开拓新地块' })).toBeTruthy());
    // 降级来源必须如实写出来
    await waitFor(() => expect(screen.getByText(/来自内置词池/)).toBeTruthy());
  });
});
