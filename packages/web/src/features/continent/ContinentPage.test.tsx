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
 * ★ canvas 在 jsdom 下拿不到 2d 上下文：地图组件遇到 `null` 会**直接退出绘制**（正合此处的目的
 *   ——渲染不参与交互锁）；点击命中走 `getBoundingClientRect` 比例换算，故这里给它一个真矩形。
 * ★ 点击**按格子坐标**触发：地图只上报 `(row, col)`（领地可能落在没铺词条的荒地上），
 *   故这里的 `clickCell` 也必须按格子走——这正是"点击语义分流在页面"这条设计的接口面。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor, screen, within } from '@testing-library/react';
import { CONTINENT_CODEX_SLOTS, computeReviewState } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { buildContinentView } from './continent-view';

const apiMock = { map: vi.fn(), mark: vi.fn() };
vi.mock('../../lib/api', () => ({ api: { terms: apiMock } }));
vi.mock('./MonsterDialog', () => ({
  MonsterDialog: (props: {
    tile: { id: string; term: string };
    onSolved: (t: { id: string; term: string }) => void;
    onClose: () => void;
  }) => (
    <div className="stub-monster-dialog">
      <button className="stub-solve" onClick={() => void props.onSolved(props.tile)}>
        答完
      </button>
      <button className="stub-close" onClick={props.onClose}>
        关
      </button>
    </div>
  ),
}));

const { ContinentPage } = await import('./ContinentPage');

/** 注入的「现在」；词条时间偏移都以它为基准（本地日历日差稳定，不受时区影响） */
const NOW = new Date('2026-09-26T12:00:00Z');

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 一条词条。默认形态＝「stage 0 间隔 1 天、入库 3 天前 ⇒ 逾期 2 天」；`inScope` 决定它冒不冒怪。
 * `over` 用来造别的形态（例：`settledTerms()` 造"刚复习过 ⇒ 未到期"的普通地块）。
 * ★ `review` 一律由 `computeReviewState` 现算，不手写——手写锁的是"我以为是的样子"。
 */
function termOf(id: string, inScope: boolean, over: Partial<ContinentMapTerm> = {}): ContinentMapTerm {
  const createdAt = over.created_at ?? daysAgo(3);
  const stage = over.review_stage ?? 0;
  const lastReviewedAt = over.last_reviewed_at ?? null;
  return {
    id,
    term: `词条${id}`,
    definition: `释义${id}`,
    domain: 'js',
    importance: 0.5,
    usage_count: 3,
    ...over,
    created_at: createdAt,
    updated_at: createdAt,
    review_stage: stage,
    last_reviewed_at: lastReviewedAt,
    review_in_scope: inScope ? 1 : 0,
    review: over.review ?? computeReviewState({ stage, lastReviewedAt, createdAt, now: NOW }),
  };
}

/** 六条「刚复习过 ⇒ 未到期」的普通地块：把中心内圈铺满，但它们**不冒怪**（英雄因此有地方站） */
function settledTerms(): ContinentMapTerm[] {
  return ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].map((id) =>
    termOf(id, true, { created_at: daysAgo(10), review_stage: 1, last_reviewed_at: daysAgo(0) }),
  );
}

/**
 * 一只**离中心两格**的怪：入库比 `settledTerms()` 晚 ⇒ 铺在它们外一圈；逾期 6 天 ⇒ 本体 + 3 格领地。
 * ★ 用它才能测到"够不着"：只有一条词条时英雄会正好站在怪脚下（那种情况下点它就是相邻，测不出闸门）。
 */
function beastTerm(): ContinentMapTerm {
  return termOf('m', true, { created_at: daysAgo(7) });
}

/**
 * 一只**独占全图**的深逾期怪：库里没有别的词条 ⇒ 它吞下的每一格都是**荒地**。
 * ★ 这是"荒地领地必须点得动"的最短通道：只有它能保证 `wildLands` 非空
 *   （词条密集时领地会被"词条格优先"全吃掉，荒地一格也剩不下）。
 */
function loneBeastTerm(): ContinentMapTerm {
  return termOf('solo', true, { created_at: daysAgo(30) });
}

/** 地图尺寸（与 ContinentMap 的 CONTINENT_COLS×ROWS×CELL 一致） */
const MAP_W = 672;
const MAP_H = 480;
const CELL = 48;

/** 给 canvas 一个真矩形，并按比例喂一个坐标（命中换算与真实浏览器同一路径） */
function clickAt(x: number, y: number): void {
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('地图没渲染出来');
  canvas.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: MAP_W,
    height: MAP_H,
    top: 0,
    right: MAP_W,
    bottom: MAP_H,
    left: 0,
    toJSON: () => ({}),
  });
  fireEvent.click(canvas, { clientX: x, clientY: y });
}

/** 点某一格的中心（地图只认格子坐标，故测试也按格子点） */
function clickCell(row: number, col: number): void {
  clickAt(col * CELL + CELL / 2, row * CELL + CELL / 2);
}

/** 中心格（14×10 ⇒ 第 7 列第 5 行）——词条从中心长出来，故单条词条必然落在这里 */
const CENTER_ROW = 5;
const CENTER_COL = 7;

beforeAll(() => {
  // jsdom 不实现 canvas 2d：返回 null 让地图组件直接退出绘制（渲染不参与本文件的断言）
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ContinentPage 首屏与横幅', () => {
  it('取数成功：标题/统计/地图同屏，且范围外到期的词条单独给一句提示', async () => {
    apiMock.map.mockResolvedValue({ terms: [termOf('a', true), termOf('b', false)] });
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

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
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    clickCell(CENTER_ROW, CENTER_COL);
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
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    clickCell(CENTER_ROW, CENTER_COL);
    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText(/该词条未纳入复习范围/)).toBeTruthy());
    expect(apiMock.map).toHaveBeenCalledTimes(1); // 没刷新 ⇒ 没有假成功
  });

  it('★ 够不着的怪点不动：只招呼你走过去，不许隔空开打', async () => {
    const terms = [...settledTerms(), beastTerm()];
    apiMock.map.mockResolvedValue({ terms });
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    const view = buildContinentView(terms);
    const beast = view.tiles.find((t) => t.id === 'm');
    if (!beast) throw new Error('地图上应该有这只怪');
    expect(beast.hasMonster).toBe(true);
    expect(beast.row).toBe(CENTER_ROW - 1); // 铺在中心外一圈 ⇒ 与英雄（中心）隔着两格

    clickCell(beast.row, beast.col);
    expect(screen.getByText(/先走到「词条m」旁边再点它开打/)).toBeTruthy();
    expect(document.querySelector('.stub-monster-dialog')).toBeNull(); // 没开打 ⇒ 没弹窗
  });

  it('★ 点荒地上的领地格 → 打领主（那格没有词条，但必须点得动）', async () => {
    const terms = [loneBeastTerm()];
    apiMock.map.mockResolvedValue({ terms });
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    const view = buildContinentView(terms);
    // 这只怪把没铺过词条的荒地也吞了（`tiles` 里没有它们，单列在 `wildLands`）
    expect(view.wildLands.length).toBeGreaterThan(0);
    const land = view.wildLands[0];
    if (!land) throw new Error('应该有落在荒地上的领地');

    clickCell(land.row, land.col);
    // ★ 点领地＝复习领主，且**不要求相邻**（照抄 demo 的 `review_unlock`：那是解除占领的唯一路径）
    expect(screen.getByText(/这是「词条solo」的领地/)).toBeTruthy();
    expect(document.querySelector('.stub-monster-dialog')).toBeTruthy();
  });

  it('点普通地块（范围外）→ 出详情卡并说明为什么没冒怪', async () => {
    apiMock.map.mockResolvedValue({ terms: [termOf('b', false)] });
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

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