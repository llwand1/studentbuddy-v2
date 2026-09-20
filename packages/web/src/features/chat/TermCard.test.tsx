// @vitest-environment jsdom
/**
 * TermCard.test — 词条卡的**「向 AI 追问」接线**（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §6）。
 *
 * 钉的是"屏幕上的东西真的出来了、点下去真的带着对的东西走了"这一层：
 * 未注入时不渲染假控件、注入后出一行输入 + 按钮、留空 ⇒ `undefined`（交给服务端补默认问法）、
 * Enter 与点击同效、失败必须**说出来**、成功**不回文案**（此刻卡片已被切走的会话卸载）。
 *
 * 判定规则（`term` 超长拒绝、问题截断、标题截断）在 `shared/follow-up.test.ts`；
 * 服务端建会话与连边在 `server/{chat/follow-up,routes/fork,learning/follow-up-links}.test.ts`。
 * 本文件**不重复**那些，只钉接线。
 *
 * ★ `afterEach(cleanup)` 是**必须**的：本仓 `vitest.config.ts` 没有开 `globals`，
 *   RTL 的自动清理不生效，不显式清理会让上一个用例的 DOM 残留 ⇒ `getByRole` 命中多个元素而失败。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { TermCard } from './TermCard';
import { ApiError, type TermItem } from '../../lib/api';

const TERM: TermItem = {
  id: 'term-1',
  term: '闭包',
  definition: '函数 + 它定义时的词法作用域',
  domain: 'cs',
  aliases: ['closure'],
  source_session_id: null,
  source_title: null,
  importance: 0.8,
  usage_count: 12,
  last_used_at: null,
  created_at: '2026-09-01 00:00:00',
  updated_at: '2026-09-01 00:00:00',
  review_stage: 2,
  last_reviewed_at: '2026-09-10 00:00:00',
  review_in_scope: 1,
  review_enabled: null,
};

/** 渲染完整卡（可选注入 followUp 动作）；`say` 刻意不传 ⇒ 不触碰语音 API */
function renderCard(followUp?: (term: string, question?: string) => Promise<void>, variant: 'mini' | 'full' = 'full') {
  return render(
    <TermCard
      item={TERM}
      variant={variant}
      onClose={() => undefined}
      {...(followUp ? { onFollowUp: followUp } : {})}
    />,
  );
}

const input = () => screen.queryByPlaceholderText(/想问这个词条什么/);
const askBtn = () => screen.queryByRole('button', { name: '向 AI 追问' });

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('渲染条件 — 不做假控件', () => {
  it('★ 未注入 onFollowUp ⇒ 整组控件不渲染（同 openTerms 的手法）', () => {
    renderCard();
    expect(input()).toBeNull();
    expect(askBtn()).toBeNull();
  });

  it('注入后 ⇒ 一行输入 + 一个按钮（输入框 placeholder 说清"留空也行"）', () => {
    renderCard(() => Promise.resolve());
    expect(input()).not.toBeNull();
    expect(askBtn()).not.toBeNull();
    expect(input()?.getAttribute('placeholder')).toContain('留空');
  });

  it('★ mini 卡（悬停速览）不渲染追问控件——追问是"要操作"那档强度的事', () => {
    renderCard(() => Promise.resolve(), 'mini');
    expect(askBtn()).toBeNull();
  });
});

describe('发起追问', () => {
  it('填了问题 ⇒ 以 (词条名, 问题) 调用；用的是 item.term 而不是正文命中原文', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderCard(fn);
    fireEvent.change(input() as HTMLElement, { target: { value: '它和柯里化什么关系？' } });
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn).toHaveBeenCalledWith('闭包', '它和柯里化什么关系？'));
  });

  it('★ 留空 ⇒ 第二参为 undefined（交给服务端补默认问法，不是空串）', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderCard(fn);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn).toHaveBeenCalledWith('闭包', undefined));
  });

  it('只打了空白 ⇒ 同样算"没填"（trim 后为空就回落默认问法）', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderCard(fn);
    fireEvent.change(input() as HTMLElement, { target: { value: '    ' } });
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn).toHaveBeenCalledWith('闭包', undefined));
  });

  it('Enter 与点击同效（输入框里回车本来就没有别的用途）', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderCard(fn);
    fireEvent.change(input() as HTMLElement, { target: { value: '再讲讲' } });
    fireEvent.keyDown(input() as HTMLElement, { key: 'Enter' });
    await waitFor(() => expect(fn).toHaveBeenCalledWith('闭包', '再讲讲'));
  });

  it('进行中：按钮禁用并换成占位符（连点也点不动）', async () => {
    // ★ 用对象字段而不是裸 `let`：TS 的控制流分析看不到「赋值发生在 Promise 回调里」，
    //   会把裸 `let release: (() => void) | null = null` 一路窄化成 `null`（进而报 TS2349）。
    //   属性读不被这样窄化，是这类"手动闸门"测试的标准写法。
    const gate: { release?: () => void } = {};
    const fn = vi.fn(
      () =>
        new Promise<void>((r) => {
          gate.release = r;
        }),
    );
    renderCard(fn);
    fireEvent.click(askBtn() as HTMLElement);
    const busyBtn = await screen.findByRole('button', { name: '开新对话…' });
    // 本仓不引 @testing-library/jest-dom（零第三方运行时库），故断言原生 DOM 属性
    expect((busyBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busyBtn);
    expect(fn).toHaveBeenCalledTimes(1);
    gate.release?.();
  });
});

describe('失败与成功', () => {
  it('★ 失败必须说出来，且按钮恢复可用（能重试）', async () => {
    const fn = vi.fn(() => Promise.reject(new ApiError(404, '会话不存在')));
    renderCard(fn);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(screen.getByText('会话不存在')).toBeTruthy());
    expect((screen.getByRole('button', { name: '向 AI 追问' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('非 ApiError 的异常 ⇒ 给一句能看懂的兜底文案（不把原始异常糊到屏幕上）', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('boom')));
    renderCard(fn);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(screen.getByText('追问失败，请稍后重试')).toBeTruthy());
  });

  it('★ 成功不回文案：此刻卡片已被切走的会话卸载，写「已开新对话」只会闪一下', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderCard(fn);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/已开新对话|已创建/)).toBeNull();
  });
});
