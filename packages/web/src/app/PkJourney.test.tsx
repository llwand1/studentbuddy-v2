// @vitest-environment jsdom
/**
 * PkJourney.test — 「两块屏」那一节的**一致性**回归锁（2026-09-21 对战整节批）。
 *
 * ★ 这一节的卖点只有一条：**两块屏在同一秒钟读同一份快照**。所以这里锁的不是「有没有画」，
 *   而是三条会被人改坏的性质：
 *   ① 两侧那个剩余秒数**必须一模一样**（同一个 `tick` 派生。一旦有人把某一侧改成本地起表，
 *      这条立刻红——那是这一节唯一的立身之本）；
 *   ② 比分只能按契约涨：一圈 = 两道题 = 双方各自拿 +1 与 +2 ⇒ 每圈各 +3、且永不倒退，
 *      并且**加分那一帧**要和契约对上（出题 +1 在题落地那帧，答对 +2 在判分那帧）；
 *   ③ 屏态矩阵：每帧两侧各画哪几块，一帧不多一帧不少（多出来的就是产品里没有的东西）。
 * ★ 另有一条通用不变量：屏上出现的每个数都得在产品里**可能出现**——上一批正是在这条上
 *   翻出 hero 演示的「求助 2」（契约每局只有 `HELP_PER_MATCH = 1` 个道具）。
 * ★ 假时钟在这里不是「测 setInterval 会不会响」：两侧读数是时间派生值，不推进就只能证明
 *   第 0 帧那一种取值，而这一节要证的恰好是「换了帧还对不对得上」。
 *
 * ★ 2026-09-22 中英切换批：本文件跑在**中文口径**上（直挂 `<PkJourney/>`、不带 Provider，
 *   `LandingLangContext` 默认 `zh`）⇒ 上面三条性质与语言无关，一条语义都不用改，只把取文案
 *   的写法改成 `.zh`。★ 帧表本批拆到 `./pk-frames`（屏态积木留在 `./pk-boards`），
 *   「每帧画哪几块」这件事仍然只由那张表决定——英文侧想偷偷换屏态，得先改表类型。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act, type RenderResult } from '@testing-library/react';
import { HELP_PER_MATCH } from '@sb/shared';
import { PkJourney } from './PkJourney';
import { PK_SCORE } from './pk-boards';
import { PK_FRAMES } from './pk-frames';

const TICK_MS = 500;
const FRAME_TICKS = 5;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 帧内块 → 产品侧的选择器（`.sb-pk-*` 全部是产品的类名，这里没有第二套样式可锁） */
const BLOCKS = {
  pending: '.sb-pk-pending',
  answer: '.sb-pk-options',
  verdict: '.sb-pk-verdict-flash',
  done: '.sb-pk-fold',
  quiz: '.sb-pk-form',
} as const;
type BlockKey = keyof typeof BLOCKS | 'waiting';

/** 「等待对手作答」那张卡（`PkMatch.tsx:251-261`）：有题干有剩余秒，但没有选项区也没有出题表单 */
function hasWaiting(el: Element): boolean {
  return Array.from(el.querySelectorAll('.sb-pk-card')).some(
    (card) =>
      !!card.querySelector('.sb-pk-stem') &&
      !!card.querySelector('.sb-pk-deadline') &&
      !card.querySelector(BLOCKS.answer) &&
      !card.querySelector(BLOCKS.quiz),
  );
}
function isOn(el: Element, key: BlockKey): boolean {
  return key === 'waiting' ? hasWaiting(el) : !!el.querySelector(BLOCKS[key]);
}
const ALL_KEYS: BlockKey[] = [...(Object.keys(BLOCKS) as (keyof typeof BLOCKS)[]), 'waiting'];
function keysOn(el: Element): BlockKey[] {
  return ALL_KEYS.filter((k) => isOn(el, k));
}
const screensOf = (c: HTMLElement) => Array.from(c.querySelectorAll('.landing-pk-screen'));
const deadlineTexts = (el: Element) => Array.from(el.querySelectorAll('.sb-pk-deadline')).map((n) => n.textContent);

/** 渲染并推进到第 `f` 帧第 `k` 格（`act` 里走假时钟，React 18 才会把 setState 冲刷完） */
function at(f: number, k = 0): RenderResult {
  vi.useFakeTimers();
  const view = render(<PkJourney />);
  act(() => {
    vi.advanceTimersByTime((f * FRAME_TICKS + k) * TICK_MS);
  });
  return view;
}
/** 取该帧的两块屏；结构变了就抛错，逼着改的人重写矩阵而不是删掉断言 */
function pair(view: RenderResult, where: string): [Element, Element] {
  const [mine, his] = screensOf(view.container);
  if (!mine || !his) throw new Error(`两块屏少了一块（${where}）⇒ 按新结构重写本锁，别直接删`);
  return [mine, his];
}

describe('PkJourney — 两块屏在同一秒钟读同一份快照', () => {
  it('恰好两块屏，每块都用产品自己的页面容器；双屏整块对读屏隐藏', () => {
    const { container } = render(<PkJourney />);
    const list = screensOf(container);
    expect(list.length).toBe(2);
    for (const el of list) expect(el.querySelector('.sb-pk')).toBeTruthy();
    expect(container.querySelector('.landing-pk-boards')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('★ 五帧 × 两侧的屏态矩阵：一帧不多一帧不少', () => {
    const MINE: BlockKey[][] = [['quiz'], ['quiz', 'waiting'], ['done', 'quiz'], ['answer'], ['quiz', 'verdict']];
    const HIS: BlockKey[][] = [['pending'], ['answer'], ['quiz', 'verdict'], ['quiz', 'waiting'], ['done']];
    expect(PK_FRAMES.length).toBe(MINE.length);
    PK_FRAMES.forEach((_, f) => {
      const view = at(f);
      const [mine, his] = pair(view, `帧 ${f}`);
      expect(keysOn(mine).sort(), `帧 ${f} 我这侧`).toEqual([...(MINE[f] ?? [])].sort());
      expect(keysOn(his).sort(), `帧 ${f} 他那侧`).toEqual([...(HIS[f] ?? [])].sort());
      // 主题条是公开快照的一部分，两侧每帧都得有、且同一个值
      const t = (el: Element) => el.querySelector('.sb-pk-topic-name')?.textContent;
      expect(t(mine), `帧 ${f} 两侧主题不一致`).toBe(t(his));
      // ★ 但「这是谁的主题」那一行**必须按看屏的人各说一遍**（`pk-view.ts:105-109`）：
      //   主题只属于两个人里的一个 ⇒ 两块屏上恰好一块写「你的主题」、另一块写「对手 的主题」。
      //   写成同一个词＝上帝视角，正是这一节要反驳的东西。
      const own = (el: Element) => el.querySelector('.sb-pk-topic-owner')?.textContent;
      expect([own(mine), own(his)].filter((s) => s === '你的主题').length, `帧 ${f}「你的主题」不是恰好一块屏`).toBe(1);
      expect([own(mine), own(his)].filter((s) => s === '对手 的主题').length, `帧 ${f}「对手 的主题」不是恰好一块屏`).toBe(1);
      expect(own(mine), `帧 ${f} 两块屏的主题归属行写成了一样（拿上帝视角画产品）`).not.toBe(own(his));
      // ★ 两块屏同时开着出题框的那一帧（03）：那行字是各人自己敲的，**不许是同一段**
      const prompt = (el: Element) => el.querySelector('.sb-pk-input')?.textContent;
      if (prompt(mine) && prompt(his))
        expect(prompt(mine), `帧 ${f} 两块屏的出题框写了同一段话`).not.toBe(prompt(his));
      cleanup();
    });
  });

  it('★ 同一帧两侧那个剩余秒一模一样（被拆成两张表就会红）', () => {
    for (const f of [1, 3]) {
      for (const k of [0, 2, 4]) {
        const view = at(f, k);
        const [mine, his] = pair(view, `帧 ${f}`);
        const a = deadlineTexts(mine);
        const b = deadlineTexts(his);
        expect(a.length, `帧 ${f} 我这侧该恰好一个剩余秒`).toBe(1);
        expect(b.length, `帧 ${f} 他那侧该恰好一个剩余秒`).toBe(1);
        expect(a[0], `帧 ${f} 格 ${k}：两块屏的读数对不上`).toBe(b[0]);
        cleanup();
      }
    }
  });

  it('剩余秒始终落在 45s 起算的那段里（一帧 2.5 秒走不到 ≤10s 变红那一档 ⇒ 那档刻意没搬）', () => {
    for (const f of [1, 3]) {
      for (let k = 0; k < FRAME_TICKS; k += 1) {
        const view = at(f, k);
        for (const el of screensOf(view.container)) {
          for (const text of deadlineTexts(el)) {
            const sec = Number((text ?? '').replace('s', ''));
            expect(sec).toBeLessThanOrEqual(45);
            expect(sec).toBeGreaterThan(10);
          }
        }
        cleanup();
      }
    }
  });

  it('★ 比分按契约涨：一圈双方各 +3、任何一帧不倒退、加分时刻与 +1/+2 对齐', () => {
    const seq = (side: 'mine' | 'his') => {
      const out: number[] = [];
      for (let lap = 0; lap < 2; lap += 1) {
        for (let f = 0; f < PK_FRAMES.length; f += 1) out.push(PK_SCORE[side](lap, f));
      }
      return out;
    };
    for (const side of ['mine', 'his'] as const) {
      const s = seq(side);
      for (let i = 1; i < s.length; i += 1) expect(s[i] ?? 0).toBeGreaterThanOrEqual(s[i - 1] ?? 0);
      expect(s[PK_FRAMES.length] ?? 0).toBe((s[0] ?? 0) + 3); // 一整圈 +3
    }
    expect(PK_SCORE.mine(0, 1) - PK_SCORE.mine(0, 0)).toBe(1); // 我这侧 +1：题落地那帧（成功出题）
    expect(PK_SCORE.mine(0, 4) - PK_SCORE.mine(0, 3)).toBe(2); // 我这侧 +2：我答对那帧
    expect(PK_SCORE.his(0, 2) - PK_SCORE.his(0, 1)).toBe(2); // 他那侧 +2：他答对那帧
    expect(PK_SCORE.his(0, 3) - PK_SCORE.his(0, 2)).toBe(1); // 他那侧 +1：他的题落地那帧
  });

  it('屏上每个数都要在产品里可能出现：求助数 ≤ 每局道具上限（上一批翻出过「求助 2」）', () => {
    for (let f = 0; f < PK_FRAMES.length; f += 1) {
      const { container } = at(f);
      const subs = Array.from(container.querySelectorAll('.landing-pk-screen .sb-pk-sub')).map((n) => n.textContent ?? '');
      expect(subs.length).toBeGreaterThan(0);
      for (const text of subs) {
        const m = /求助\s*(\d+)/.exec(text);
        if (!m?.[1]) throw new Error(`屏态小字里没有「求助 N」了：${text} ⇒ 本锁随之失效，按新读法重写`);
        expect(Number(m[1])).toBeLessThanOrEqual(HELP_PER_MATCH);
      }
      cleanup();
    }
  });

  it('「对手正在出题」那一帧不许有进度条（产品刻意不做假进度条，PK-SPEC §13.1）', () => {
    const { container } = at(0);
    const boards = container.querySelector('.landing-pk-boards');
    expect(boards?.querySelector('.sb-pk-pending')).toBeTruthy();
    expect(boards?.querySelector('progress, [role="progressbar"]')).toBeNull();
  });

  it('五步说明一条都不为动效让路：五行全在、全标已落地、lead/desc 全文都在 DOM 里', () => {
    const { container } = render(<PkJourney />);
    expect(container.querySelectorAll('.landing-pk-steps .landing-jstep').length).toBe(PK_FRAMES.length);
    expect(container.querySelectorAll('.landing-pk-steps .landing-jtag').length).toBe(PK_FRAMES.length);
    const text = container.textContent ?? '';
    for (const { title, lead, desc } of PK_FRAMES) {
      expect(text).toContain(title.zh);
      expect(text).toContain(lead.zh);
      expect(text).toContain(desc.zh);
    }
  });
});
