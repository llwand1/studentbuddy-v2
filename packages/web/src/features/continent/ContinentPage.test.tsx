// @vitest-environment jsdom
/**
 * ContinentPage.test — 知识大陆（开拓制）页的**接线与死路锁**（jsdom；api 全 mock，答题/追问弹窗空桩化）。
 *
 * 锁住的静默死路：
 *   ① 迷雾边缘点了没反应（锁：紧挨着 ⇒ 调 explore；隔得远 ⇒ 只招呼走过去，不调写口）；
 *   ② 打倒野怪没真的写服务端（锁：弹窗答完 ⇒ slay(row,col,day) + 回话"开拓了 N 块地"）；
 *   ③ 遗忘之影答完没打卡 / 没重取（锁：mark(id,true) + 二次取词条）；
 *   ④ 地块详情里找不到追问入口（锁：点地块 ⇒ 详情卡带「追问升级」⇒ 打开追问弹窗）；
 *   ⑤ 零词条 / 取数失败白屏。
 * ★ 点击按世界格走：相机初始＝英雄居中，用同一个 `camFor` 现算视口坐标（不写死偏移）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/react';
import { CONTINENT_CODEX_SLOTS, computeReviewState, newWorld, worldFromPlacements, type WorldSave } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { buildContinentView, initialHeroCell } from './continent-view';
import { camFor } from './useContinentCamera';

const apiMock = { map: vi.fn(), mark: vi.fn() };
const worldMock = { world: vi.fn(), explore: vi.fn(), slay: vi.fn(), delve: vi.fn(), delveFinish: vi.fn() };
const cardsMock = { state: vi.fn() };
const npcMock = { state: vi.fn() };
const emberMock = vi.hoisted(() => ({ spot: vi.fn(async () => ({ spot: null })), mine: vi.fn(async () => ({ notes: [] })) }));
vi.mock('../../lib/api', () => ({ api: { terms: apiMock, continent: worldMock, cards: cardsMock, npc: npcMock, ember: emberMock } }));
vi.mock('./MonsterDialog', () => ({
  MonsterDialog: (props: { tile: { id: string }; onSolved: (t: unknown) => void; onClose: () => void }) => (
    <div className="stub-monster-dialog">
      <button className="stub-solve" onClick={() => void props.onSolved(props.tile)}>答完</button>
    </div>
  ),
}));
vi.mock('./DelveDialog', () => ({ DelveDialog: () => <div className="stub-delve-dialog" /> }));

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

/** 地图尺寸 = **视口**大小（14×10 格 × 48px；世界比它大，故点击坐标要先过相机） */
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


function termOfAt(id: string, inScope: boolean, over: Partial<ContinentMapTerm> = {}): ContinentMapTerm {
  return termOf(id, inScope, over);
}
/** 刚复习过 ⇒ 未到期（不冒遗忘之影） */
function calm(id: string): ContinentMapTerm {
  return termOfAt(id, true, { created_at: daysAgo(10), review_stage: 1, last_reviewed_at: daysAgo(0) });
}

let terms: ContinentMapTerm[] = [];
let world: WorldSave = newWorld(1);
const DAY = 0;

function serve(t: ContinentMapTerm[], w: WorldSave): void {
  terms = t;
  world = w;
  apiMock.map.mockResolvedValue({ terms: t });
  worldMock.world.mockResolvedValue({ world: w, termCount: t.length, day: DAY });
}

function viewNow() {
  return buildContinentView(terms, world, DAY);
}

function clickWorld(row: number, col: number): void {
  const view = viewNow();
  const cam = camFor(initialHeroCell(view.tiles), view.radius);
  clickCell(row - cam.row, col - cam.col);
}

async function ready(): Promise<void> {
  render(<ContinentPage />);
  await waitFor(() => expect(screen.getByText('已开拓')).toBeTruthy());
  await waitFor(() => expect(worldMock.world).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/正在展开大陆/)).toBeNull());
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  cardsMock.state.mockResolvedValue({ wall: [] });
  npcMock.state.mockResolvedValue({
    partnerName: '', npcs: [], tradesLeft: 2,
    quota: { count: 0, max: 6, doneTasks: 0, needTasks: 0, canCreate: false, blockedBy: '还没有词条' },
    spots: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ContinentPage 首屏', () => {
  it('取数成功：标题 + 开拓制统计 + 地图；范围外到期单独提示', async () => {
    serve([termOfAt('a', false)], worldFromPlacements(1, [{ id: 'a', row: 0, col: 0 }]));
    await ready();
    expect(screen.getByRole('heading', { name: /知识大陆/ })).toBeTruthy();
    expect(screen.getByText('开拓令')).toBeTruthy();
    expect(document.querySelector('canvas')).toBeTruthy();
    expect(screen.getByText(/还有 1 条到期词条没纳入复习范围/)).toBeTruthy();
  });

  it('零词条：出空态文案（不是白屏）', async () => {
    serve([], newWorld(1));
    await ready();
    expect(screen.getByText(/四周都是迷雾/)).toBeTruthy();
  });

  it('取数失败：把错误话念出来', async () => {
    apiMock.map.mockRejectedValue(new Error('断网了'));
    worldMock.world.mockRejectedValue(new Error('断网了'));
    render(<ContinentPage />);
    await waitFor(() => expect(screen.getByText(/地图加载失败：断网了/)).toBeTruthy());
  });
});

describe('ContinentPage 开拓与战斗', () => {
  it('★ 紧挨着的迷雾格 → explore(row,col)', async () => {
    serve([calm('a')], worldFromPlacements(1, [{ id: 'a', row: 0, col: 0 }]));
    worldMock.explore.mockResolvedValue({ world, termCount: 1, day: DAY, fresh: [{ row: 0, col: 1 }] });
    await ready();
    const target = viewNow().frontier.find((f) => !viewNow().monsters.some((m) => m.row === f.row && m.col === f.col));
    if (!target) throw new Error('应该有空的迷雾边缘');
    clickWorld(target.row, target.col);
    await waitFor(() => expect(worldMock.explore).toHaveBeenCalledWith(target.row, target.col));
  });

  it('★ 太远的迷雾不开拓：只提示', async () => {
    serve([calm('a')], worldFromPlacements(1, [{ id: 'a', row: 0, col: 0 }]));
    await ready();
    clickWorld(4, 4);
    expect(screen.getByText(/迷雾太深了/)).toBeTruthy();
    expect(worldMock.explore).not.toHaveBeenCalled();
  });

  it('★ 相邻野怪 → 开打；答完 → slay(row,col,day) + 回话', async () => {
    const t = ['a', 'b', 'c', 'd'].map(calm);
    // 找一颗让出生点四邻就有野怪的种子
    const P = [{ id: 'a', row: 0, col: 0 }, { id: 'b', row: 0, col: 1 }, { id: 'c', row: 1, col: 0 }, { id: 'd', row: 1, col: 1 }];
    const adj = (w: WorldSave) => {
      const v = buildContinentView(t, w, DAY);
      const h = initialHeroCell(v.tiles);
      return h ? v.monsters.find((m) => Math.abs(m.row - h.row) + Math.abs(m.col - h.col) === 1) : undefined;
    };
    let w: WorldSave | null = null;
    for (let seed = 1; seed < 400 && !w; seed++) {
      const c = worldFromPlacements(seed, P);
      if (adj(c)) w = c;
    }
    if (!w) throw new Error('找不到合适的种子');
    serve(t, w);
    await ready();
    const foe = adj(w)!;
    worldMock.slay.mockResolvedValue({ world: w, termCount: 4, day: DAY, fresh: [{ row: foe.row, col: foe.col }, { row: 9, col: 9 }], species: 'judge' });
    clickWorld(foe.row, foe.col);
    expect(document.querySelector('.stub-monster-dialog')).toBeTruthy();
    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(worldMock.slay).toHaveBeenCalledWith(foe.row, foe.col, DAY));
    await waitFor(() => expect(screen.getByText(/一口气开拓了 2 块地/)).toBeTruthy());
  });

  it('遗忘之影（逾期词条）答完 → 打卡 + 重取词条 + 地上留宝箱', async () => {
    const w = worldFromPlacements(1, [{ id: 'a', row: 0, col: 0 }, { id: 'b', row: 0, col: 1 }]);
    serve([termOfAt('a', true), calm('b')], w);
    apiMock.mark.mockResolvedValue(termOfAt('a', true));
    await ready();
    clickWorld(0, 0);
    expect(document.querySelector('.stub-monster-dialog')).toBeTruthy();
    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(apiMock.mark).toHaveBeenCalledWith('a', true));
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/地上有 1 个宝箱/)).toBeTruthy());
  });
});

describe('ContinentPage 地块与面板', () => {
  it('★ 点有词条的地块 → 详情卡 → 追问升级 → 打开追问弹窗', async () => {
    serve([calm('a')], worldFromPlacements(1, [{ id: 'a', row: 0, col: 0 }]));
    await ready();
    clickWorld(0, 0);
    expect(document.querySelector('.continent-detail')).toBeTruthy();
    fireEvent.click(screen.getByText(/追问升级（0→1 级）/));
    expect(document.querySelector('.stub-delve-dialog')).toBeTruthy();
  });

  it('看图鉴 / 建筑图谱：面板都能打开', async () => {
    serve([], newWorld(1));
    await ready();
    fireEvent.click(screen.getByText('看图鉴'));
    await waitFor(() => expect(document.querySelectorAll('.continent-codex-cell')).toHaveLength(CONTINENT_CODEX_SLOTS));
    fireEvent.click(screen.getByText('建筑图谱'));
    await waitFor(() => expect(screen.getAllByText(/贤者书库/).length).toBeGreaterThan(0));
  });
});
