// @vitest-environment jsdom
/**
 * SpellChant.test — 吟唱框的交互锁（契约 `docs/SPELL-CHANT-SPEC.md` §3.3–3.4）。
 *
 * ★ 锁四条：① 复述没到阈值不能「吟诵」（按钮禁用、回车只给提示）、到了才放行；② 重做题一次作答，
 *   对 = 命中、错 = 失谐并亮答案；③ 全部节完成 → 释放 → 结算 → `onCast(damage, detail)` 的数字与 shared 口径一致
 *   （命中数 × 共鸣倍率）；④ 跳过 = 失谐，全跳 ⇒ 哑火仍如实交给父组件（0），不静默。
 * ★ 前三条把 `matchMedia` 桩成「减少动态效果」：跳过释放动画阶段（动画本体在 `spell-fx.test.ts` 里锁）。
 *   第四条放开它、用假时钟走完释放：命中帧（`SPELL_KIND_META[kind].impactMs`）伤害数字才出现、卡片挂 `struck`，
 *   到 `durationMs` 才结算——DOM 与 canvas 引擎必须查同一张表。
 * ★ `kind` / `seed` 由外面传定（不传就是掷骰）：结算文案与 `onCast` 的 `detail.kind` 都得是这一款。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SPELL_KINDS, SPELL_KIND_META, SPELL_RESONANCE_MULTIPLIER, type ChantVerse, type SpellKind } from '@sb/shared';
import { SpellChant } from './SpellChant';

afterEach(cleanup);

/** 桩 matchMedia：`calm` = 用户要求减少动态效果 */
function stubMotion(calm: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: calm && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  stubMotion(true);
  // jsdom 没有 canvas：与 ContinentPage.test 同一口径桩掉，让 SpellFx 静默不画（也不刷 "Not implemented" 噪音）
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

const verses: ChantVerse[] = [
  { kind: 'recall', prompt: '什么是傅里叶变换？', echo: '把信号拆成不同频率的正弦波之和。' },
  { kind: 'quiz', question: { type: 'single', question: '傅里叶变换把时域变成？', options: ['频域', '空域'], answer: [0] }, title: '傅里叶小测' },
];

function mount(over: Partial<{ resonant: boolean; verses: ChantVerse[]; kind: SpellKind }> = {}) {
  const onCast = vi.fn();
  const onClose = vi.fn();
  const kind = over.kind ?? 'salamander';
  const view = render(
    <SpellChant
      term="傅里叶变换"
      title="那次聊信号"
      plan={{ verses: over.verses ?? verses, truncated: 0, resonant: over.resonant ?? true }}
      kind={kind}
      seed={7}
      onCast={onCast}
      onClose={onClose}
    />,
  );
  return { onCast, onClose, kind, container: view.container };
}

/** 走完两节（复述命中 + 答题命中）到「释放」按钮 */
function chantBoth(): void {
  fireEvent.change(screen.getByRole('textbox', { name: '复述提问' }), { target: { value: '什么是傅里叶变换' } });
  fireEvent.click(screen.getByRole('button', { name: '吟诵' }));
  fireEvent.click(screen.getByRole('button', { name: 'A. 频域' }));
  fireEvent.click(screen.getByRole('button', { name: '作答' }));
  fireEvent.click(screen.getByRole('button', { name: '下一节' }));
}

describe('魔法吟唱：逐节吟唱到释放', () => {
  it('复述不像 ⇒ 不能吟诵；像了 ⇒ 放行；答对题 ⇒ 命中；释放伤害 = 命中数 × 共鸣倍率', () => {
    const { onCast, kind } = mount();
    expect(screen.getByText('第 1 节 · 复述当初的提问')).toBeTruthy();
    expect(screen.getByText(SPELL_KIND_META[kind].name).className).toContain('spell-kind-tag');
    expect(screen.getByText(/把信号拆成不同频率/)).toBeTruthy();
    const chant = screen.getByRole('button', { name: '吟诵' }) as HTMLButtonElement;
    expect(chant.disabled).toBe(true);
    const input = screen.getByRole('textbox', { name: '复述提问' });
    fireEvent.change(input, { target: { value: '今天晚饭吃什么' } });
    expect(chant.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText(/还差一点/)).toBeTruthy();
    fireEvent.change(input, { target: { value: '傅里叶变换是什么' } });
    expect(chant.disabled).toBe(false);
    fireEvent.click(chant);

    expect(screen.getByText('第 2 节 · 重做当初的题')).toBeTruthy();
    const answer = screen.getByRole('button', { name: '作答' }) as HTMLButtonElement;
    expect(answer.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'A. 频域' }));
    fireEvent.click(answer);
    expect(screen.getByText(/命中/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一节' }));

    const damage = 2 * SPELL_RESONANCE_MULTIPLIER;
    expect(screen.getByText(new RegExp(`化作「${SPELL_KIND_META[kind].name}」`))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `释放咒语（${damage} 点）` }));
    expect(screen.getByText(new RegExp(`化作「${SPELL_KIND_META[kind].name}」：造成 ${damage} 点伤害`))).toBeTruthy();
    expect(onCast).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '回到战斗' }));
    expect(onCast).toHaveBeenCalledWith(damage, { power: 2, total: 2, resonant: true, kind });
  });

  it('答错 = 失谐并亮出答案；不共鸣不加倍', () => {
    const { onCast } = mount({ resonant: false });
    fireEvent.change(screen.getByRole('textbox', { name: '复述提问' }), { target: { value: '什么是傅里叶变换' } });
    fireEvent.click(screen.getByRole('button', { name: '吟诵' }));
    fireEvent.click(screen.getByRole('button', { name: 'B. 空域' }));
    fireEvent.click(screen.getByRole('button', { name: '作答' }));
    expect(screen.getByText(/失谐。正确答案：A\. 频域/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一节' }));
    fireEvent.click(screen.getByRole('button', { name: '释放咒语（1 点）' }));
    fireEvent.click(screen.getByRole('button', { name: '回到战斗' }));
    expect(onCast).toHaveBeenCalledWith(1, { power: 1, total: 2, resonant: false, kind: 'salamander' });
  });

  it('跳过 = 失谐；全部失谐 ⇒ 哑火，仍以 0 交给父组件；中断走 onClose', () => {
    const { onCast, onClose } = mount({ verses: [verses[0] as ChantVerse] });
    fireEvent.click(screen.getByRole('button', { name: '中断' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '跳过这一节' }));
    fireEvent.click(screen.getByRole('button', { name: '释放（哑火）' }));
    expect(screen.getByText(/哑火/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '回到战斗' }));
    expect(onCast).toHaveBeenCalledWith(0, { power: 0, total: 1, resonant: true, kind: 'salamander' });
  });

  it('释放阶段按款式表走时序：命中帧才出伤害数字并震卡片，到时长才结算；不传 kind 则掷骰到五款之一', () => {
    stubMotion(false);
    vi.useFakeTimers();
    try {
      const { onCast, kind, container } = mount({ kind: 'grace' });
      const meta = SPELL_KIND_META[kind];
      chantBoth();
      fireEvent.click(screen.getByRole('button', { name: `释放咒语（${2 * SPELL_RESONANCE_MULTIPLIER} 点）` }));
      const card = container.querySelector('.spell-card') as HTMLElement;
      expect(card.className).toContain(`kind-${kind}`);
      expect(card.className).toContain('phase-cast');
      expect(container.querySelector('canvas.spell-fx')?.getAttribute('data-kind')).toBe(kind);
      expect(container.querySelector('.spell-cast-num')).toBeNull();
      act(() => vi.advanceTimersByTime(meta.impactMs - 1));
      expect(container.querySelector('.spell-cast-num')).toBeNull();
      expect(card.className).not.toContain('struck');
      act(() => vi.advanceTimersByTime(1));
      expect(container.querySelector('.spell-cast-num')?.textContent).toBe(String(2 * SPELL_RESONANCE_MULTIPLIER));
      expect(card.className).toContain('struck');
      expect(card.className).toContain('phase-cast');
      act(() => vi.advanceTimersByTime(meta.durationMs - meta.impactMs));
      expect(container.querySelector('.spell-card')?.className).toContain('phase-done');
      fireEvent.click(screen.getByRole('button', { name: '回到战斗' }));
      expect(onCast).toHaveBeenCalledWith(2 * SPELL_RESONANCE_MULTIPLIER, { power: 2, total: 2, resonant: true, kind });
    } finally {
      vi.useRealTimers();
    }
    cleanup();
    const onCast = vi.fn();
    const { container } = render(
      <SpellChant term="傅里叶变换" title="那次聊信号" plan={{ verses: [], truncated: 0, resonant: false }} onCast={onCast} onClose={() => undefined} />,
    );
    const rolled = SPELL_KINDS.find((k) => container.querySelector('.spell-card')?.classList.contains(`kind-${k}`));
    expect(rolled).toBeDefined();
    expect(screen.getByText(SPELL_KIND_META[rolled as SpellKind].name)).toBeTruthy();
  });
});
