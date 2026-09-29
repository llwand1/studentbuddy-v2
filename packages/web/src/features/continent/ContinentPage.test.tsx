// @vitest-environment jsdom
/**
 * ContinentPage.test — 知识大陆页的**交互与死路锁**（jsdom；`api.terms` 全 mock，`MonsterDialog` 空桩化）。
 *
 * 本页真正的风险不是"画得不好看"，而是四条**静默死路**（都不会报错，用户只会觉得"点了没反应"）：
 *   ① 范围外的到期词条被画成怪 ⇒ 点进去打卡必 409（本文件锁：它只铺地、不冒怪，并给出一句提示）；
 *   ② 答对之后没有真的打卡 / 没有重取地图 ⇒ 怪永远不消失（锁：`mark(id,true)` 被调用 + 二次取数 + 回话）；
 *   ③ 零词条 / 取数失败时白屏（锁：空态与失败横幅都要出字）；
 *   ④ **隔空打怪**与**领地格点不动**（锁：够不着时不许开打、要先走过去；荒地上的领地格必须能点开领主）。
 *
 * ★ `MonsterDialog` 被空桩化：**出题与判分是它自己的事**（`shared/continent.ts` 已由纯函数测试锁住），
 *   本文件只管「答完 → 打卡 → 刷新」这条**接线**。不空桩就得在 jsdom 里重演五种题型的作答手势，
 *   那锁的是"我复现的答题流程"，而不是本页的接线。
 * ★ 桩与手势（造词条 / 按格点击 / 相机换算）在 `ContinentPage.testkit.tsx`，与 `ContinentPage.spawn.test.tsx`
 *   （野怪 / 边界「+」）共用一份——两份用例、一份口径。
 * ★ 点击**按格子坐标**触发：地图只上报 `(row, col)`（领地可能落在没铺词条的荒地上），
 *   故这里的 `clickCell` 也必须按格子走——这正是"点击语义分流在页面"这条设计的接口面。
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor, screen, within } from '@testing-library/react';
import { CONTINENT_CODEX_SLOTS } from '@sb/shared';
import { buildContinentView } from './continent-view';
import {
  CENTER_COL,
  CENTER_ROW,
  MonsterDialogStub,
  apiMock,
  beastTerm,
  cardsMock,
  clickCell,
  clickWorld,
  daysAgo,
  installContinentPageHooks,
  loneBeastTerm,
  npcMock,
  settledTerms,
  termOf,
  viewportOf,
} from './ContinentPage.testkit';

vi.mock('../../lib/api', () => ({ api: { terms: apiMock, cards: cardsMock, npc: npcMock } }));
vi.mock('./MonsterDialog', () => ({ MonsterDialog: MonsterDialogStub }));

const { ContinentPage } = await import('./ContinentPage');

installContinentPageHooks();

describe('ContinentPage 首屏与横幅', () => {
  it('取数成功：标题/统计/地图同屏，且范围外到期的词条单独给一句提示', async () => {
    apiMock.map.mockResolvedValue({ terms: [termOf('a', true), termOf('b', false)] });
    render(<ContinentPage />);
    await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/)); // ★ 等"铺好"再断言：mock 被调用 ≠ 已 resolve 并重渲染，紧跟的同步断言并发下会闪红

    expect(screen.getByRole('heading', { name: /知识大陆/ })).toBeTruthy();
    expect(screen.getByText('待收复的怪')).toBeTruthy();
    expect(screen.getByText('被占领的地')).toBeTruthy();
    expect(document.querySelector('canvas')).toBeTruthy();
    // ★ 只有 a 冒怪（在范围内），b 虽然也到期但范围外 ⇒ 必须走提示而不是画成怪
    expect(screen.getByText(/还有 1 条到期词条没纳入复习范围/)).toBeTruthy();
    const view = buildContinentView([termOf('a', true), termOf('b', false)]);
    expect(view.monsterCount).toBe(1);
    expect(view.dueOutOfScope).toBe(1);
  });

  it('零词条：出空态文案（不是白屏）', async () => {
    apiMock.map.mockResolvedValue({ terms: [] });
    render(<ContinentPage />);
    await waitFor(() => expect(screen.getByText(/大陆还是一片空地/)).toBeTruthy());
  });

  it('取数失败：把错误话念出来，不吞', async () => {
    apiMock.map.mockRejectedValue(new Error('断网了'));
    render(<ContinentPage />);
    await waitFor(() => expect(screen.getByText(/地图加载失败：断网了/)).toBeTruthy());
  });
});

describe('ContinentPage 交互', () => {
  it('点怪 → 打开答题弹窗；弹窗答完 → 打卡 + 重取地图 + 回话 + 地上留一箱', async () => {
    apiMock.map.mockResolvedValue({ terms: [termOf('a', true)] });
    apiMock.mark.mockResolvedValue(termOf('a', true));
    render(<ContinentPage />);
    await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/)); // ★ 同前：铺好再点，否则相机还没对齐、这一下会落到别的格

    clickCell(CENTER_ROW, CENTER_COL); // 单条词条 ⇒ 世界中心 (0,0) 恒落在视口中心格
    expect(document.querySelector('.stub-monster-dialog')).toBeTruthy();

    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(apiMock.mark).toHaveBeenCalledWith('a', true));
    // ★ 重取地图是怪消失的唯一途径（状态在服务端推进）；不回话用户不知道刚才做了什么
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/收复了「词条a」/)).toBeTruthy());
    // 打怪留下的宝箱落在地上（它是既有每日宝箱账本的第二入口，不是新账本）
    await waitFor(() => expect(screen.getByText(/地上有 1 个宝箱/)).toBeTruthy());
  });

  it('打卡失败：错误话念出来，弹窗不关（不假装收复了）', async () => {
    apiMock.map.mockResolvedValue({ terms: [termOf('a', true)] });
    apiMock.mark.mockRejectedValue(new Error('该词条未纳入复习范围'));
    render(<ContinentPage />);
    await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/)); // ★ 同前：铺好再点

    clickCell(CENTER_ROW, CENTER_COL);
    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText(/该词条未纳入复习范围/)).toBeTruthy());
    expect(apiMock.map).toHaveBeenCalledTimes(1); // 没刷新 ⇒ 没有假成功
  });

  it('★ 够不着的怪点不动：只招呼你走过去，不许隔空开打', async () => {
    const terms = [...settledTerms(), beastTerm()];
    apiMock.map.mockResolvedValue({ terms });
    render(<ContinentPage />);
    await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/)); // ★ 同前：铺好再点

    const view = buildContinentView(terms);
    const beast = view.tiles.find((t) => t.id === 'm');
    if (!beast) throw new Error('地图上应该有这只怪');
    expect(beast.hasMonster).toBe(true);
    // 铺在中心外一圈 ⇒ **视口里**与英雄（视口中心）隔着两格（世界坐标已改成有符号，故比的是视口格）
    expect(viewportOf(view, beast.row, beast.col).row).toBe(CENTER_ROW - 1);

    clickWorld(view, beast.row, beast.col);
    expect(screen.getByText(/先走到「词条m」旁边再点它开打/)).toBeTruthy();
    expect(document.querySelector('.stub-monster-dialog')).toBeNull(); // 没开打 ⇒ 没弹窗
  });

  it('★ 点荒地上的领地格 → 打领主（那格没有词条，但必须点得动）', async () => {
    const terms = [loneBeastTerm()];
    apiMock.map.mockResolvedValue({ terms });
    render(<ContinentPage />);
    await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/)); // ★ 同前：铺好再点

    const view = buildContinentView(terms);
    // 这只怪把没铺过词条的荒地也吞了（`tiles` 里没有它们，单列在 `wildLands`）
    expect(view.wildLands.length).toBeGreaterThan(0);
    const land = view.wildLands[0];
    if (!land) throw new Error('应该有落在荒地上的领地');

    clickWorld(view, land.row, land.col);
    // ★ 点领地＝复习领主，且**不要求相邻**（照抄 demo 的 `review_unlock`：那是解除占领的唯一路径）
    expect(screen.getByText(/这是「词条solo」的领地/)).toBeTruthy();
    expect(document.querySelector('.stub-monster-dialog')).toBeTruthy();
  });

  it('点普通地块（范围外）→ 出详情卡并说明为什么没冒怪', async () => {
    // ★ 今天复习过 ⇒ 不会被野怪盯上（否则单条词条必是当天唯一的野怪位，点开的就是打怪弹窗）
    apiMock.map.mockResolvedValue({ terms: [termOf('b', false, { review_stage: 1, last_reviewed_at: daysAgo(0) })] });
    render(<ContinentPage />);
    await waitFor(() => expect(document.querySelector('.continent-map-hint')?.textContent).toMatch(/视野内 [1-9]/)); // ★ 同前：铺好再点

    clickCell(CENTER_ROW, CENTER_COL);
    const detail = document.querySelector('.continent-detail');
    expect(detail).toBeTruthy();
    expect(screen.getByText('释义b')).toBeTruthy();
    // ★ 用 within 限定在详情卡里找：横幅里也有一句「没纳入复习范围」，全局查会撞出两处
    expect(within(detail as HTMLElement).getByText(/未纳入复习范围/)).toBeTruthy();
  });

  it('看图鉴 → 面板渲染，槽数由题型表派生；宝箱已不是空桩，不该再有"未接入"字样', async () => {
    apiMock.map.mockResolvedValue({ terms: [] });
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('看图鉴'));
    await waitFor(() => expect(document.querySelector('.continent-codex')).toBeTruthy());
    expect(document.querySelectorAll('.continent-codex-cell')).toHaveLength(CONTINENT_CODEX_SLOTS);
    expect(screen.queryByText(/尚未接入/)).toBeNull();
  });
});