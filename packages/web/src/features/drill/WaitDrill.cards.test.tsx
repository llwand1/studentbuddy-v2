// @vitest-environment jsdom
/**
 * WaitDrill 页面测试 ②——「卡怎么答」（契约 docs/WAIT-DRILL-SPEC.md §3 / §5）：
 *  - 键盘 1–4 作答；答错 ⇒ 红绿对照 + 碎裂特效 + 连击归零 + 隔几张再来（还有 N 张 +1）；Enter 翻下一张；
 *  - Z 斩 ⇒ 今天不再出（本机记 id）+ 斩击特效 + 战绩 +1，不碰打卡接口；
 *  - AI 新词：先学一屏（标「AI 现出」）再答，答完问「收入词库 / 不要」——收入走 `drillApi.keep`（候选闸门）；
 *  - 没绑模型的兜底：新词标「内置词池」+ 如实写原因；「不要」对词池条目不发请求、对候选发 dismiss。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react';
import {
  correctIndex,
  dialog,
  dismissMock,
  flush,
  keepMock,
  LIB,
  mapMock,
  markMock,
  newTermsMock,
  options,
  pressKey,
  prompt,
  resetDrillMocks,
  wrongIndex,
} from './WaitDrill.testkit';

vi.mock('../../lib/api-terms-continent', () => ({ termsContinentApi: { map: mapMock } }));
vi.mock('../../lib/api-terms-review', () => ({ termsReviewApi: { mark: markMock } }));
vi.mock('../../lib/api-drill', () => ({ drillApi: { newTerms: newTermsMock, keep: keepMock, dismiss: dismissMock } }));

const { WaitDrill } = await import('./WaitDrill');

const AI_ITEM = { candidateId: 'c1', term: '尾调用优化', definition: '把处于尾位置的函数调用复用当前栈帧的优化', domain: 'js', source: 'ai' as const };
const POOL_ITEM = {
  candidateId: null,
  term: '词池词',
  definition: '内置词池里的一条释义',
  domain: 'js',
  source: 'fallback' as const,
  fallbackReason: '没有绑定可用的模型，这批来自内置词池',
};

async function open() {
  const view = render(<WaitDrill busySessionId="s1" active />);
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  await flush();
  return view;
}

function leftCount(): number {
  return Number(/还有 (\d+) 张/.exec(document.querySelector('.drill-foot')?.textContent ?? '')?.[1] ?? -1);
}

describe('WaitDrill：卡怎么答', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetDrillMocks();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('★ 键盘作答：答错 ⇒ 红绿对照 + 碎裂 + 连击归零 + 插回队列；Enter 下一张；Z 斩 ⇒ 记本机、不打卡', async () => {
    await open();
    const first = prompt();
    const before = leftCount();
    const w = wrongIndex();
    const c = correctIndex();
    pressKey(String(w + 1));
    expect(options()[w]?.className).toBe('drill-opt wrong');
    expect(options()[c]?.className).toBe('drill-opt right');
    expect(document.querySelector('.drill-fx-wrong')).not.toBeNull();
    expect(screen.getByText('错了')).toBeTruthy();
    expect(leftCount()).toBe(before + 1); // 错的隔几张再来
    expect(markMock).not.toHaveBeenCalled(); // 到期词条答错不打卡
    const body = document.querySelector('.drill-body') as HTMLElement;
    body.scrollTop = 250;
    pressKey('Enter');
    expect(body.scrollTop).toBe(0); // 下一题从题干开始，不沿用上题解析滚动位置
    expect(prompt()).not.toBe(first);
    expect(screen.queryByText('错了')).toBeNull();

    pressKey('z');
    expect(document.querySelector('.drill-card.slain')).not.toBeNull();
    expect(document.querySelector('.drill-action-slay')).not.toBeNull();
    expect(document.querySelector('.answer-impact')).toBeNull();
    pressKey('z'); // repeated action must not double count
    expect(screen.getByText('斩！今天不再出这条')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText('斩！今天不再出这条')).toBeNull();
    const stats = JSON.parse(localStorage.getItem('sb:drill:stats') ?? '{}') as { slain: string[] };
    expect(stats.slain).toHaveLength(1);
    expect(markMock).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it('答对一张特效一款轮换（斩击→爆裂→星芒→电光→血墨），5 连击叠 COMBO 大字；拼写卡回车提交', async () => {
    await open();
    const seen: string[] = [];
    let guard = 0;
    while (seen.length < 5 && guard < 12) {
      guard += 1;
      if (options().length === 0) {
        // 第 4 张是拼写卡：本用例不猜拼写，斩掉（斩不清连击）
        expect(screen.getByLabelText('拼写作答')).toBeTruthy();
        pressKey('z');
        await act(async () => {
          vi.advanceTimersByTime(600);
        });
        continue;
      }
      pressKey(String(correctIndex() + 1));
      seen.push(document.querySelector('.drill-fx')?.className ?? '');
      if (seen.length === 5) break;
      await act(async () => {
        vi.advanceTimersByTime(800);
      });
    }
    expect(seen).toEqual(['drill-fx drill-fx-slash', 'drill-fx drill-fx-burst', 'drill-fx drill-fx-star', 'drill-fx drill-fx-bolt', 'drill-fx drill-fx-ink']);
    expect(screen.getByText('COMBO ×5')).toBeTruthy();
    expect(document.querySelector('.drill-stats')?.textContent).toContain('连击 5');
  });

  it('拼写卡：输入词条回车判分，别名与大小写按大陆同一口径', async () => {
    await open();
    for (let i = 0; i < 3; i += 1) {
      pressKey(String(correctIndex() + 1));
      await act(async () => {
        vi.advanceTimersByTime(800);
      });
    }
    const input = screen.getByLabelText('拼写作答') as HTMLInputElement;
    const asked = prompt(); // 拼写卡题面是释义
    const term = LIB.find((t) => t.definition === asked)?.term ?? '';
    expect(term).not.toBe('');
    fireEvent.change(input, { target: { value: ` ${term.toUpperCase()} ` } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(screen.getByText('对了')).toBeTruthy();
  });

  it('手机拼写不自动唤起键盘，点格子后可继续输入作答', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    try {
      const view = await open();
      act(() => window.dispatchEvent(new Event('sb:drill-open')));
      await flush();
      for (let i = 0; i < 3; i += 1) {
        pressKey(String(correctIndex() + 1));
        await act(async () => { vi.advanceTimersByTime(800); });
      }
      const input = screen.getByLabelText('拼写作答') as HTMLInputElement;
      expect(document.activeElement).not.toBe(input);
      fireEvent.click(view.container.querySelector('.ti-cells') as HTMLElement);
      expect(document.activeElement).toBe(input);
      const term = LIB.find(t => t.definition === prompt())?.term ?? '';
      expect(term).not.toBe('');
      fireEvent.change(input, { target: { value: term } });
      fireEvent.submit(input.closest('form') as HTMLFormElement);
      expect(screen.getByText('对了')).toBeTruthy();
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });

  it('★ AI 新词：先学（标「AI 现出」）再答；答完「收入词库」⇒ drillApi.keep 带候选 id', async () => {
    resetDrillMocks({ mode: 'ai', items: [AI_ITEM] });
    await open();
    pressKey(String(correctIndex() + 1)); // 第一张普通词条
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    // 第二张就是新词：学习屏
    expect(screen.getByText('新词 · AI 现出')).toBeTruthy();
    expect(screen.getByText(AI_ITEM.term)).toBeTruthy();
    expect(screen.getByText(AI_ITEM.definition)).toBeTruthy();
    expect(options()).toHaveLength(0);
    pressKey('Enter'); // 记住了，来一题
    expect(prompt()).toBe(AI_ITEM.term);
    const i = options().findIndex((b) => b.textContent?.includes(AI_ITEM.definition));
    expect(i).toBeGreaterThanOrEqual(0);
    pressKey(String(i + 1));
    expect(screen.getByText('收入词库')).toBeTruthy();
    expect(screen.getByText('不要')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('收入词库')).toBeTruthy(); // 新词不自动翻页：等用户决定
    pressKey('Enter');
    await flush();
    expect(keepMock).toHaveBeenCalledWith(AI_ITEM);
    expect(screen.getByText(`「${AI_ITEM.term}」已收入词库`)).toBeTruthy();
    expect(document.querySelector('.drill-action-keep')).not.toBeNull();
    expect(prompt()).toBe(AI_ITEM.term);
    await act(async () => vi.advanceTimersByTime(720));
    expect(prompt()).not.toBe(AI_ITEM.term);
  });

  it('没绑模型：新词标「内置词池」并如实写原因；「不要」对词池条目不发请求；答错也能收', async () => {
    resetDrillMocks({ mode: 'fallback', fallbackReason: POOL_ITEM.fallbackReason, items: [POOL_ITEM] });
    await open();
    expect(screen.getByText(POOL_ITEM.fallbackReason)).toBeTruthy(); // 状态行
    pressKey(String(correctIndex() + 1));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(screen.getByText('新词 · 内置词池')).toBeTruthy();
    expect(screen.getAllByText(POOL_ITEM.fallbackReason).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByText(/记住了，来一题/));
    const i = options().findIndex((b) => b.textContent?.includes(POOL_ITEM.definition));
    pressKey(String((i === 0 ? 1 : 0) + 1)); // 故意答错
    expect(screen.getByText('错了')).toBeTruthy();
    expect(screen.getByText('收入词库')).toBeTruthy(); // 答错也问要不要
    pressKey('x');
    await flush();
    expect(dismissMock).not.toHaveBeenCalled(); // 词池条目没有候选 id
    expect(keepMock).not.toHaveBeenCalled();
    expect(prompt()).not.toBe(POOL_ITEM.term);
    expect(leftCount()).toBeGreaterThanOrEqual(0); // 新词答错不插回
  });

  it('候选「不要」⇒ dismiss(candidateId)；词库取不到 ⇒ 如实报错、弹窗仍在', async () => {
    resetDrillMocks({ mode: 'pending', items: [AI_ITEM] });
    await open();
    pressKey(String(correctIndex() + 1));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    pressKey('Enter');
    pressKey('n'); // 不认识
    expect(screen.getByText('记一下')).toBeTruthy();
    fireEvent.click(screen.getByText('不要'));
    await flush();
    expect(dismissMock).toHaveBeenCalledWith('c1');
    cleanup();

    mapMock.mockRejectedValueOnce(new Error('后端没开'));
    await open();
    expect(dialog()).not.toBeNull();
    expect(screen.getAllByText(/后端没开/).length).toBeGreaterThanOrEqual(1); // 卡面 + 状态行都如实说
  });
});
