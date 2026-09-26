// @vitest-environment jsdom
/**
 * ContinentPage.test — 知识大陆页的**交互与死路锁**（jsdom；`api.terms` 全 mock，`MonsterDialog` 空桩化）。
 *
 * 本页真正的风险不是"画得不好看"，而是三条**静默死路**（都不会报错，用户只会觉得"点了没反应"）：
 *   ① 范围外的到期词条被画成怪 ⇒ 点进去打卡必 409（本文件锁：它只铺地、不冒怪，并给出一句提示）；
 *   ② 答对之后没有真的打卡 / 没有重取地图 ⇒ 怪永远不消失（锁：`mark(id,true)` 被调用 + 二次取数 + 回话）；
 *   ③ 零词条 / 取数失败时白屏（锁：空态与失败横幅都要出字）。
 *
 * ★ `MonsterDialog` 被空桩化：**出题与判分是它自己的事**（`shared/continent.ts` 已由纯函数测试锁住），
 *   本文件只管「答完 → 打卡 → 刷新」这条**接线**。不空桩就得在 jsdom 里重演四种题型的作答手势，
 *   那锁的是"我复现的答题流程"，而不是本页的接线。
 * ★ canvas 在 jsdom 下拿不到 2d 上下文：地图组件遇到 `null` 会**直接退出绘制**（正合此处的目的
 *   ——渲染不参与交互锁）；点击命中走 `getBoundingClientRect` 比例换算，故这里给它一个真矩形。
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

/** 一条逾期词条（stage 0 间隔 1 天、入库 3 天前 ⇒ 逾期 2 天）；`inScope` 决定它冒不冒怪 */
function termOf(id: string, inScope: boolean): ContinentMapTerm {
  const createdAt = daysAgo(3);
  return {
    id,
    term: `词条${id}`,
    definition: `释义${id}`,
    domain: 'js',
    importance: 0.5,
    usage_count: 3,
    created_at: createdAt,
    updated_at: createdAt,
    review_stage: 0,
    last_reviewed_at: null,
    review_in_scope: inScope ? 1 : 0,
    review: computeReviewState({ stage: 0, createdAt, now: NOW }),
  };
}

/** 地图尺寸（与 ContinentMap 的 CONTINENT_COLS×ROWS×CELL 一致）与「中心格」的点击坐标 */
const MAP_W = 672;
const MAP_H = 480;
const CENTER_X = Math.floor(14 / 2) * 48 + 24; // 第 7 列
const CENTER_Y = Math.floor(10 / 2) * 48 + 24; // 第 5 行

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
  it('点怪 → 打开答题弹窗；弹窗答完 → 打卡 + 重取地图 + 回话', async () => {
    apiMock.map.mockResolvedValue({ terms: [termOf('a', true)] });
    apiMock.mark.mockResolvedValue(termOf('a', true));
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    clickAt(CENTER_X, CENTER_Y);
    expect(document.querySelector('.stub-monster-dialog')).toBeTruthy();

    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(apiMock.mark).toHaveBeenCalledWith('a', true));
    // ★ 重取地图是怪消失的唯一途径（状态在服务端推进）；不回话用户不知道刚才做了什么
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/收复了「词条a」/)).toBeTruthy());
  });

  it('打卡失败：错误话念出来，弹窗不关（不假装收复了）', async () => {
    apiMock.map.mockResolvedValue({ terms: [termOf('a', true)] });
    apiMock.mark.mockRejectedValue(new Error('该词条未纳入复习范围'));
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    clickAt(CENTER_X, CENTER_Y);
    fireEvent.click(document.querySelector('.stub-solve') as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText(/该词条未纳入复习范围/)).toBeTruthy());
    expect(apiMock.map).toHaveBeenCalledTimes(1); // 没刷新 ⇒ 没有假成功
  });

  it('点普通地块（范围外）→ 出详情卡并说明为什么没冒怪', async () => {
    apiMock.map.mockResolvedValue({ terms: [termOf('b', false)] });
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    clickAt(CENTER_X, CENTER_Y);
    const detail = document.querySelector('.continent-detail');
    expect(detail).toBeTruthy();
    expect(screen.getByText('释义b')).toBeTruthy();
    // ★ 用 within 限定在详情卡里找：横幅里也有一句「没纳入复习范围」，全局查会撞出两处
    expect(within(detail as HTMLElement).getByText(/未纳入复习范围/)).toBeTruthy();
  });

  it('看图鉴 → 面板渲染且槽数由题型表派生；宝箱空桩文案可见（未开放要说清）', async () => {
    apiMock.map.mockResolvedValue({ terms: [] });
    render(<ContinentPage />);
    await waitFor(() => expect(apiMock.map).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('看图鉴'));
    await waitFor(() => expect(document.querySelector('.continent-codex')).toBeTruthy());
    expect(document.querySelectorAll('.continent-codex-cell')).toHaveLength(CONTINENT_CODEX_SLOTS);
    expect(screen.getByText(/宝箱与词条卡抽取尚未开放/)).toBeTruthy();
  });
});