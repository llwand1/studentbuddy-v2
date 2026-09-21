// @vitest-environment jsdom
/**
 * PkFlowDemo.test — 对战演示的**帧 × 内容矩阵**回归锁（2026-09-21 对战批）。
 *
 * ★ 这批的验收口径是老板那句话：「实际效果和演示效果差别不要太大，别货不对板」。
 *   能锁住这件事的不是时长（CSS 里的值，jsdom 读不到样式表），而是**每一帧到底画了哪几块**——
 *   产品的五个屏态本来就是互斥条件渲染（`PkMatch.tsx`），所以「一帧一块」就是它与真机一致的
 *   结构性质。多一块（比如给判定加一行对手战报）就是演示比产品花，这里会直接红。
 *
 * ★ 刻意**不测**的是那两个跳动的数字（「已过 Ns」/ 45s 递减）：那靠 setInterval 推进，
 *   用假时钟去测等于测「setInterval 会不会响」。这里只锁挂载瞬间的初值——它是产品的
 *   初始口径（`PkQuizPending.tsx:28` 的 sec=0 显示「马上就好」、时限从 45s 起算），
 *   而初值是同步可得的，不需要等任何计时器。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { HELP_PER_MATCH } from '@sb/shared';
import { PkFlowDemo } from './PkFlowDemo';
import { LANDING_DEMOS, PK_FLOW, TERM_FLOW, GRAPH_FLOW } from './registry';

afterEach(cleanup);

/** 每帧该出现的块（key = 选择器）：产品的屏态，一帧不多一帧不少 */
const BLOCKS = {
  bubble: '.ld-pk-bubble',
  pending: '.ld-pk-pending',
  question: '.ld-pk-q',
  verdict: '.ld-pk-verdict',
  result: '.ld-pk-result',
} as const;

const expectOnly = (container: HTMLElement, stage: number, on: (keyof typeof BLOCKS)[]) => {
  for (const key of Object.keys(BLOCKS) as (keyof typeof BLOCKS)[]) {
    const found = !!container.querySelector(BLOCKS[key]);
    expect(found, `帧 ${stage} 的 ${key} 应该是 ${on.includes(key) ? '在' : '不在'}`).toBe(on.includes(key));
  }
};

describe('PkFlowDemo — 帧 × 内容矩阵', () => {
  it('五帧各自只画一个屏态：对阵｜出题中｜轮到你答｜判定｜结算', () => {
    const cases: (keyof typeof BLOCKS)[][] = [['bubble'], ['bubble', 'pending'], ['question'], ['verdict'], ['result']];
    expect(PK_FLOW.stages.length).toBe(cases.length);
    cases.forEach((on, stage) => {
      const { container } = render(<PkFlowDemo stage={stage} />);
      expectOnly(container, stage, on);
      cleanup();
    });
  });

  it('对阵栏（HUD）五帧常驻；比分是无动画地换文本（产品里 SSE 回灌没有过渡）', () => {
    const mine = [0, 1, 2, 3, 4].map((stage) => {
      const { container } = render(<PkFlowDemo stage={stage} />);
      const hud = container.querySelector('.ld-pk-hud');
      const text = container.querySelector('.ld-pk-me .ld-pk-sc')?.textContent;
      expect(hud).toBeTruthy(); // 常驻：切帧不该把双方的栏切没
      expect(container.querySelectorAll('.ld-pk-me').length).toBe(1);
      cleanup();
      return text;
    });
    expect(mine).toEqual(['3', '3', '3', '5', '5']); // 判定那一下才涨分
  });

  it('判定只闪我自己那一条横幅（产品的对手战报只体现为比分，不是第二行）', () => {
    const { container } = render(<PkFlowDemo stage={3} />);
    expect(container.querySelectorAll('.ld-pk-verdict').length).toBe(1);
    expect(container.querySelector('.ld-pk-v-text')?.textContent).toBe('答对 +2');
  });

  it('答题帧：四个选项、恰好一个选中期，时限初值 45s（产品的单选题形态）', () => {
    const { container } = render(<PkFlowDemo stage={2} />);
    expect(container.querySelectorAll('.ld-pk-o').length).toBe(4);
    expect(container.querySelectorAll('.ld-pk-o.picked').length).toBe(1);
    expect(container.querySelector('.ld-pk-deadline')?.textContent).toBe('45s');
    expect(container.querySelector('.ld-pk-deadline.urgent')).toBeNull(); // 45s 时不该就提示紧张
  });

  it('出题帧：初值是「马上就好」而不是「已过 0s」，骨架屏三行、没有假进度条', () => {
    const { container } = render(<PkFlowDemo stage={1} />);
    expect(container.querySelector('.ld-pk-p-sec')?.textContent).toBe('马上就好');
    expect(container.querySelectorAll('.ld-pk-sk-line').length).toBe(3);
    // 产品注释写死「不做假进度条」（PkQuizPending.tsx 头注）⇒ 演示窗里也不许出现进度条元素
    expect(container.querySelector('.ld-pk-progress, .ld-pk-bar, [role="progressbar"]')).toBeNull();
  });

  it('结算帧：胜、终局比分两侧、且末帧在 reduce 下静态可读（元素齐备不依赖动画）', () => {
    const { container } = render(<PkFlowDemo stage={4} />);
    expect(container.querySelector('.ld-pk-r-badge')?.textContent).toContain('胜');
    expect([...container.querySelectorAll('.ld-pk-num')].map((n) => n.textContent)).toEqual(['1', '5']);
    expect(container.querySelectorAll('.ld-pk-r-side.won').length).toBe(1);
  });

  it('★ HUD 那行小字里的每个数都必须在产品里可能出现：求助数 ≤ 每局道具上限', () => {
    // 本批自查就是在这里翻出「我 · 求助 2」——契约每局只有 `HELP_PER_MATCH` 个道具，
    // 那是实物里根本不可能出现的读数（货不对板最容易被忽略的一类：不是动效假，是**数字**假）。
    for (const stage of [0, 1, 2, 3, 4]) {
      const { container } = render(<PkFlowDemo stage={stage} />);
      const subs = [...container.querySelectorAll('.ld-pk-hud .ld-pk-sub')].map((n) => n.textContent ?? '');
      expect(subs.length).toBeGreaterThanOrEqual(2); // 两侧各自的「答对 n/m · 求助 x」
      for (const text of subs) {
        const m = /求助\s*(\d+)/.exec(text);
        if (!m?.[1]) throw new Error(`HUD 小字里没有「求助 N」了：${text} ⇒ 本锁随之失效，按新读法重写`);
        expect(Number(m[1]), `帧 ${stage}：${text}`).toBeLessThanOrEqual(HELP_PER_MATCH);
      }
      cleanup();
    }
  });
});

describe('演示注册表 — 顺序与可扩展性', () => {
  it('注册表按「机制 → 产物 → 应用」排：词条 → 知识图 → 对战', () => {
    expect(LANDING_DEMOS.map((d) => d.key)).toEqual([TERM_FLOW.key, GRAPH_FLOW.key, PK_FLOW.key]);
  });

  it('每个演示的标题非空、帧数 ≥2、每帧都有说明与时长', () => {
    for (const d of LANDING_DEMOS) {
      expect(d.title.length, `${d.key} 的标题不能为空`).toBeGreaterThan(0);
      expect(d.stages.length).toBeGreaterThanOrEqual(2);
      for (const s of d.stages) {
        expect(s.caption.length).toBeGreaterThan(0);
        expect(s.ms).toBeGreaterThan(0);
      }
    }
  });

  it('对战帧时长必须 ≥ 帧内计时器走完的耗时（否则数字会被切在半路）', () => {
    // 出题中：8 格 × 380ms = 3040ms；答题：45 格 × 90ms = 4050ms
    const pending = PK_FLOW.stages[1];
    const answering = PK_FLOW.stages[2];
    if (!pending || !answering) throw new Error('对战演示的帧数或帧序变了 ⇒ 本锁按新帧号重算，别直接删');
    expect(pending.ms).toBeGreaterThanOrEqual(8 * 380);
    expect(answering.ms).toBeGreaterThanOrEqual(45 * 90);
  });
});
