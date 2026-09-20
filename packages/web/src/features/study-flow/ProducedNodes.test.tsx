// @vitest-environment jsdom
/**
 * ProducedNodes.test — 学习流页「本次运行产出的词条」上的**「向 AI 追问」接线**
 * （契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §6、`docs/STUDY-FLOW-SPEC.md` §6）。
 *
 * 钉的是这一层：什么时候**不给**控件（未注入动作 / 没有父会话 / 不是词条节点）、
 * 给了之后点下去**带着什么走**（`(词条名, 问题|undefined, 那一次运行的会话 id)`）、
 * 失败必须说出来、成功不回文案。
 *
 * ★ 本文件**唯一**要死守的一条：**第三个参数是"那次运行的会话"，不是"当前会话"**。
 *   学习流页与对话页是两个视图，这里没有 `currentId` 可用；传错就等于从别的会话分叉。
 *
 * 判定规则（词条名超长拒绝、标题截断、默认问法）在 `shared/follow-up.test.ts`；
 * 服务端建会话与连边在 `server/{chat/follow-up,routes/fork,learning/follow-up-links}.test.ts`；
 * 词条卡那边的同款接线在 `chat/TermCard.test.tsx`。本文件**不重复**那些。
 *
 * ★ `afterEach(cleanup)` 是**必须**的：本仓 `vitest.config.ts` 没有开 `globals`，
 *   RTL 的自动清理不生效，不显式清理会让上一个用例的 DOM 残留 ⇒ 查询命中多个元素而失败。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import type { KnowledgeNode } from '@sb/shared';
import { ApiError } from '../../lib/api';
import { ProducedNodes, PRODUCED_SHOWN_MAX } from './ProducedNodes';

/** 造一个产出节点（默认是 `term`——`emitTermNodes` 目前只产这一种） */
function node(over: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id: 'n-1',
    kind: 'term',
    refId: 't-1',
    refText: '闭包',
    sourceRunId: 'run-1',
    sourceStepId: 'step-1',
    createdAt: '2026-09-20 10:00:00',
    ...over,
  };
}

/** 渲染产出块；`followUp` 不传 ⇒ 不注入动作（走"只读"那条路） */
function renderNodes(
  nodes: KnowledgeNode[],
  followUp?: (term: string, question?: string, fromSessionId?: string) => Promise<void>,
  sessionId: string | null = 's-run',
) {
  return render(
    <ProducedNodes nodes={nodes} sessionId={sessionId} {...(followUp ? { onFollowUp: followUp } : {})} />,
  );
}

const chip = (name: string) => screen.queryByRole('button', { name });
const input = () => screen.queryByPlaceholderText(/想问这个词条什么/);
const askBtn = () => screen.queryByRole('button', { name: '向 AI 追问' });

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('渲染条件 — 不做假控件', () => {
  it('没有产出 ⇒ 整块不渲染（连"这次运行产出了"那句也不出现）', () => {
    const { container } = renderNodes([], () => Promise.resolve());
    expect(container.textContent).toBe('');
  });

  it('★ 未注入 onFollowUp ⇒ 词条**不可点**（只读一档，同词条卡的手法）', () => {
    renderNodes([node()]);
    expect(chip('闭包')).toBeNull();
    expect(screen.getByText('闭包')).toBeTruthy(); // 仍然显示，只是没有动作
  });

  it('注入后 ⇒ 词条变成可点按钮，且提示句点明"点一个可以直接追问"', () => {
    renderNodes([node()], () => Promise.resolve());
    expect(chip('闭包')).not.toBeNull();
    expect(screen.getByText(/点一个可以直接向 AI 追问/)).toBeTruthy();
  });

  it('★ 只有 `term` 节点给入口：`note` 节点即使注入了动作也不可点', () => {
    renderNodes([node({ id: 'n-2', kind: 'note', refId: 'q-1', refText: '错题：时态' })], () => Promise.resolve());
    expect(chip('错题：时态')).toBeNull();
    expect(screen.getByText('错题：时态')).toBeTruthy();
  });

  it('★ 这次运行没有关联会话（sessionId 为 null）⇒ 不给可点控件，也不吹"可以追问"', () => {
    renderNodes([node()], () => Promise.resolve(), null);
    expect(chip('闭包')).toBeNull();
    expect(screen.queryByText(/点一个可以直接向 AI 追问/)).toBeNull();
  });

  it('未选中时不渲染输入框（避免 12 个节点各挂一个输入框）', () => {
    renderNodes([node()], () => Promise.resolve());
    expect(input()).toBeNull();
    expect(askBtn()).toBeNull();
  });
});

describe('选中与收起', () => {
  it('点词条 ⇒ 展开一行输入 + 按钮，且 placeholder 说清"留空也行"', () => {
    renderNodes([node()], () => Promise.resolve());
    fireEvent.click(chip('闭包') as HTMLElement);
    expect(input()).not.toBeNull();
    expect(askBtn()).not.toBeNull();
    expect(input()?.getAttribute('placeholder')).toContain('留空');
  });

  it('再点一次 ⇒ 收起（同一个词条点两下是"我不要了"，不是"再问一遍"）', () => {
    renderNodes([node()], () => Promise.resolve());
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.click(chip('闭包') as HTMLElement);
    expect(input()).toBeNull();
  });

  it('★ 换一个词条 ⇒ 草稿清空（框里此刻讲的是另一个词，留着上一个词的问题最容易误发）', () => {
    renderNodes([node(), node({ id: 'n-2', refText: '柯里化' })], () => Promise.resolve());
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.change(input() as HTMLElement, { target: { value: '和柯里化什么关系？' } });
    fireEvent.click(chip('柯里化') as HTMLElement);
    expect((input() as HTMLInputElement).value).toBe('');
  });
});

describe('发起追问 — 参数必须带对', () => {
  it('★ 填了问题 ⇒ (词条名, 问题, 那一次运行的会话 id)', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderNodes([node()], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.change(input() as HTMLElement, { target: { value: '它和柯里化什么关系？' } });
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn).toHaveBeenCalledWith('闭包', '它和柯里化什么关系？', 's-run'));
  });

  it('★ 留空 ⇒ 第二参为 undefined（交给服务端补默认问法，不是空串）', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderNodes([node()], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn).toHaveBeenCalledWith('闭包', undefined, 's-run'));
  });

  it('只打了空白 ⇒ 同样算"没填"（trim 后为空就回落默认问法）', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderNodes([node()], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.change(input() as HTMLElement, { target: { value: '   ' } });
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn).toHaveBeenCalledWith('闭包', undefined, 's-run'));
  });

  it('★ 用的是节点名（`refText`）而不是节点 id —— 服务端按名字找词条行才连得上边', async () => {
    // 这个用例要看 `mock.calls` 的第 0 个实参，故 mock 必须有形参（零参 mock 的 `calls` 是 `[]` 元组）
    const fn = vi.fn((_term: string, _question?: string, _from?: string) => Promise.resolve());
    renderNodes([node({ id: 'node-xyz', refText: '闭包' })], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn.mock.calls[0]?.[0]).toBe('闭包'));
  });

  it('Enter 与点击同效（输入框里回车本来就没有别的用途）', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderNodes([node()], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.change(input() as HTMLElement, { target: { value: '再讲讲' } });
    fireEvent.keyDown(input() as HTMLElement, { key: 'Enter' });
    await waitFor(() => expect(fn).toHaveBeenCalledWith('闭包', '再讲讲', 's-run'));
  });

  it('进行中：按钮禁用并换成占位符（连点也点不动）', async () => {
    // ★ 用对象字段而不是裸 `let`：TS 的控制流分析看不到「赋值发生在 Promise 回调里」，
    //   会把裸 `let release: (() => void) | null = null` 一路窄化成 `null`（进而报 TS2349）。
    const gate: { release?: () => void } = {};
    const fn = vi.fn(
      () =>
        new Promise<void>((r) => {
          gate.release = r;
        }),
    );
    renderNodes([node()], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
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
    renderNodes([node()], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(screen.getByText('会话不存在')).toBeTruthy());
    expect((screen.getByRole('button', { name: '向 AI 追问' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('非 ApiError 的异常 ⇒ 一句能看懂的兜底文案（不把原始异常糊到屏幕上）', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('boom')));
    renderNodes([node()], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(screen.getByText('追问没有开起来')).toBeTruthy());
  });

  it('★ 成功不回文案：此刻页面已切到新会话、本块卸载，写「已开新对话」只会闪一下', async () => {
    const fn = vi.fn(() => Promise.resolve());
    renderNodes([node()], fn);
    fireEvent.click(chip('闭包') as HTMLElement);
    fireEvent.click(askBtn() as HTMLElement);
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/已开新对话|已创建/)).toBeNull();
  });
});

describe('列表上限与出口', () => {
  it(`最多列 ${PRODUCED_SHOWN_MAX} 个（一屏几百个 chip 只会淹没运行轨迹）`, () => {
    const many = Array.from({ length: PRODUCED_SHOWN_MAX + 3 }, (_, i) =>
      node({ id: `n-${i}`, refText: `词条${i}` }),
    );
    renderNodes(many, () => Promise.resolve());
    expect(screen.getAllByRole('button', { name: /^词条\d+$/ })).toHaveLength(PRODUCED_SHOWN_MAX);
    expect(screen.getByText(new RegExp(`产出了 ${PRODUCED_SHOWN_MAX + 3} 个`))).toBeTruthy();
  });

  it('注入了 onGoGraph ⇒ 「去知识图」按钮在，点了真的走', () => {
    const go = vi.fn();
    render(
      <ProducedNodes nodes={[node()]} sessionId="s-run" onGoGraph={go} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '去知识图看它们的关系' }));
    expect(go).toHaveBeenCalledTimes(1);
  });
});
