/**
 * WaitDrill.testkit — 两份 WaitDrill 页面测试共用的桩与手势（`WaitDrill.test.tsx` / `WaitDrill.cards.test.tsx`）。
 *
 * 桩三条接口：词库地图（`termsContinentApi.map`）、打卡（`termsReviewApi.mark`）、新词三件套（`drillApi`）。
 * 手势：按题面反查正确 / 错误选项——题型与选项顺序由「日历日 × 序号」哈希决定，测试不钉日期，
 * 而是读题面（词条或释义）反查词条，再在选项里找它的另一半。
 */
import { vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { computeReviewState } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';

export const mapMock = vi.fn();
export const markMock = vi.fn();
export const newTermsMock = vi.fn();
export const keepMock = vi.fn();
export const dismissMock = vi.fn();

export const LIB = [
  { id: 'd1', term: '闭包', definition: '函数与它引用的词法环境的组合' },
  { id: 'u1', term: '事件循环', definition: 'JS 运行时处理异步任务的调度机制' },
  { id: 'u2', term: '原型链', definition: '对象逐级向上查找属性的机制' },
  { id: 'u3', term: '递归', definition: '函数调用自身来解决子问题' },
  { id: 'u4', term: '哈希表', definition: '用哈希函数把键映射到桶的查找结构' },
  { id: 'u5', term: '虚拟 DOM', definition: '用 JS 对象描述界面再做差量更新的技术' },
] as const;

/** 一条到期（范围内，7 天没复习）+ 五条刚复习过的普通词条 */
export function mapPayload(): { terms: ContinentMapTerm[]; pins: [] } {
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const terms = LIB.map((t, i) => {
    const created = ago(i === 0 ? 7 : 3);
    const last = i === 0 ? null : ago(0);
    return {
      ...t,
      domain: 'js',
      importance: 0.5,
      usage_count: 2,
      created_at: created,
      updated_at: created,
      review_stage: 0,
      last_reviewed_at: last,
      review_in_scope: 1,
      review: computeReviewState({ stage: 0, lastReviewedAt: last, createdAt: created, now }),
    } as ContinentMapTerm;
  });
  return { terms, pins: [] };
}

export function resetDrillMocks(newTerms: unknown = { mode: 'empty', items: [] }): void {
  mapMock.mockReset().mockResolvedValue(mapPayload());
  markMock.mockReset().mockResolvedValue({ ok: true });
  newTermsMock.mockReset().mockResolvedValue(newTerms);
  keepMock.mockReset().mockImplementation(async (it: { term: string }) => ({ ok: true, termId: 'k1', term: it.term, candidateApproved: true }));
  dismissMock.mockReset().mockResolvedValue({ ok: true });
}

/** 让微任务跑完（假定时器下 `waitFor` 不可靠，这里手动冲） */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function options(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.drill-opt'));
}

export function prompt(): string {
  return document.querySelector('.drill-term, .drill-prompt')?.textContent ?? '';
}

/** 题面反查：这张卡在考哪条词条 */
export function askedTerm(): (typeof LIB)[number] | { term: string; definition: string } {
  const p = prompt();
  const hit = LIB.find((t) => t.term === p || t.definition === p);
  if (hit) return hit;
  return { term: p, definition: '' };
}

export function correctIndex(): number {
  const t = askedTerm();
  const want = prompt() === t.term ? t.definition : t.term;
  const i = options().findIndex((b) => b.textContent?.replace(/^\d/, '') === want);
  if (i < 0) throw new Error(`没找到正确选项：题面「${prompt()}」`);
  return i;
}

export function wrongIndex(): number {
  const c = correctIndex();
  return c === 0 ? 1 : 0;
}

export function clickCorrect(): void {
  const b = options()[correctIndex()];
  if (!b) throw new Error('没有选项按钮');
  fireEvent.click(b);
}

export function pressKey(key: string, target: Element | Window = window): void {
  fireEvent.keyDown(target, { key });
}

export function dialog(): HTMLElement | null {
  return screen.queryByRole('dialog');
}
