/**
 * ContinentPage.testkit — 知识大陆页测试的**公共桩与手势**（不是测试文件：文件名不带 `.test.`）。
 *
 * ★ 为什么拆：`ContinentPage.test.tsx` 的 mock（三个只读口 + 弹窗空桩）、造词条、按格点击这套家伙
 *   有 120 行，页面每长一个入口（2026-09-29：野怪 / 边界「+」）就要多一份用例；再堆进同一个文件
 *   会撞 320 行红线，复制一份桩又是两处口径。这里只放**桩与手势**，不放断言。
 * ★ `vi.mock(...)` 本身仍写在各测试文件里（它按文件提升）：工厂只需引用这里的 `apiMock` 等对象。
 * ★ canvas 在 jsdom 下拿不到 2d 上下文：地图组件遇到 `null` 会直接退出绘制（渲染不参与交互锁）；
 *   点击命中走 `getBoundingClientRect` 比例换算，故这里给它一个真矩形。
 */
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { computeReviewState } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { buildContinentView, initialHeroCell } from './continent-view';
import { camFor } from './useContinentCamera';

export const apiMock = { map: vi.fn(), mark: vi.fn(), scopeTerm: vi.fn(), expandOffer: vi.fn(), expandClaim: vi.fn() };
/**
 * 页面取数是**三个只读口并发**（地图 + 卡墙 + 伙伴）。
 * ★ 必须一起桩掉，否则 `Promise.all` 会因 `undefined.state()` 整体 reject，
 *   表现成"每个用例都只看到错误横幅"——那种红会把人引向"地图坏了"的错误方向。
 */
export const cardsMock = { state: vi.fn() };
export const npcMock = { state: vi.fn() };

/** `MonsterDialog` 的空桩：出题与判分是它自己的事，页面测试只管「答完 → 打卡 → 刷新」这条接线 */
export function MonsterDialogStub(props: {
  tile: { id: string; term: string };
  onSolved: (t: { id: string; term: string }) => void;
  onClose: () => void;
}) {
  return (
    <div className="stub-monster-dialog">
      <button className="stub-solve" onClick={() => void props.onSolved(props.tile)}>
        答完
      </button>
      <button className="stub-close" onClick={props.onClose}>
        关
      </button>
    </div>
  );
}

/** 注入的「现在」；词条时间偏移都以它为基准（本地日历日差稳定，不受时区影响） */
export const NOW = new Date('2026-09-26T12:00:00Z');
/** 与 `NOW` 同一天的日历键（野怪按它点名；用例里要复算"今天谁是野怪"就传它） */
export const DAY_KEY = '2026-09-26';

export function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 一条词条。默认形态＝「stage 0 间隔 1 天、入库 3 天前 ⇒ 逾期 2 天」；`inScope` 决定它冒不冒怪。
 * `over` 用来造别的形态（例：`settledTerms()` 造"刚复习过 ⇒ 未到期"的普通地块）。
 * ★ `review` 一律由 `computeReviewState` 现算，不手写——手写锁的是"我以为是的样子"。
 */
export function termOf(id: string, inScope: boolean, over: Partial<ContinentMapTerm> = {}): ContinentMapTerm {
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
export function settledTerms(): ContinentMapTerm[] {
  return ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'].map((id) =>
    termOf(id, true, { created_at: daysAgo(10), review_stage: 1, last_reviewed_at: daysAgo(0) }),
  );
}

/**
 * 一只**离中心两格**的怪：入库比 `settledTerms()` 晚 ⇒ 铺在它们外一圈；逾期 6 天 ⇒ 本体 + 3 格领地。
 * ★ 用它才能测到"够不着"：只有一条词条时英雄会正好站在怪脚下（那种情况下点它就是相邻，测不出闸门）。
 */
export function beastTerm(): ContinentMapTerm {
  return termOf('m', true, { created_at: daysAgo(7) });
}

/**
 * 一只**独占全图**的深逾期怪：库里没有别的词条 ⇒ 它吞下的每一格都是**荒地**。
 * ★ 这是"荒地领地必须点得动"的最短通道：只有它能保证 `wildLands` 非空
 *   （词条密集时领地会被"词条格优先"全吃掉，荒地一格也剩不下）。
 */
export function loneBeastTerm(): ContinentMapTerm {
  return termOf('solo', true, { created_at: daysAgo(30) });
}

/** 地图尺寸 = **视口**大小（14×10 格 × 48px；世界比它大，故点击坐标要先过相机） */
export const MAP_W = 672;
export const MAP_H = 480;
export const CELL = 48;

/** 世界格 → 视口格；★ 初始相机＝"英雄居中"（用同一个 `camFor` 现算，**不写死偏移**：写死会在相机口径改动后静默错位） */
export function viewportOf(view: ReturnType<typeof buildContinentView>, row: number, col: number) {
  const hero = initialHeroCell(view.tiles);
  const cam = camFor(hero, view.radius);
  return { row: row - cam.row, col: col - cam.col };
}

/** 点某一格（世界坐标进，内部换算成视口坐标） */
export function clickWorld(view: ReturnType<typeof buildContinentView>, row: number, col: number): void {
  const vp = viewportOf(view, row, col);
  clickCell(vp.row, vp.col);
}

/** 给 canvas 一个真矩形，并按比例喂一个坐标（命中换算与真实浏览器同一路径） */
export function clickAt(x: number, y: number): void {
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
export function clickCell(row: number, col: number): void {
  clickAt(col * CELL + CELL / 2, row * CELL + CELL / 2);
}

/** 中心格（14×10 ⇒ 第 7 列第 5 行）——词条从中心长出来，故单条词条必然落在这里 */
export const CENTER_ROW = 5;
export const CENTER_COL = 7;

/**
 * 装上页面测试的公共钩子：canvas 退出绘制、系统时间钉在 `NOW`、三个只读口给中性值、用例间清场。
 * ★ 系统时间：野怪按「日历日 × 词条 id」的稳定哈希刷，页面用 `new Date()` 取当天键；
 *   只 mock `Date`（不开假定时器，`waitFor` 仍走真实时钟），否则"今天哪条是野怪"随真实日期漂移。
 */
export function installContinentPageHooks(): void {
  beforeAll(() => {
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  });
  beforeEach(() => {
    vi.setSystemTime(NOW);
    cardsMock.state.mockResolvedValue({ wall: [] });
    npcMock.state.mockResolvedValue({
      partnerName: '',
      npcs: [],
      tradesLeft: 2,
      // ★ "数量"改由 `quota` 一次给全（名额/门票/能不能创建）；另多一份可落位格 `spots`
      quota: { count: 0, max: 6, doneTasks: 0, needTasks: 0, canCreate: false, blockedBy: '还没有词条' },
      spots: [],
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });
}
