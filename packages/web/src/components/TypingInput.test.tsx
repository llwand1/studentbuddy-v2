// @vitest-environment jsdom
/**
 * TypingInput —— 打字练习式填空控件（口径在 `@sb/shared/typing`，契约 docs/WAIT-DRILL-SPEC.md §5.2）：
 * 一格一字、符号格替你填好、键入的符号不落格、「提示」按段揭灰字、逐格对错只在 liveCheck 下、输入法组字期间不回写。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { TypingInput } from './TypingInput';

function Host({ answer, liveCheck = false, onSubmit }: { answer: string; liveCheck?: boolean; onSubmit?: () => void }) {
  const [v, setV] = useState('');
  return (
    <div>
      <TypingInput answer={answer} value={v} onChange={setV} liveCheck={liveCheck} ariaLabel="作答" {...(onSubmit ? { onSubmit } : {})} />
      <output data-testid="full">{v}</output>
    </div>
  );
}

const cells = () => Array.from(document.querySelectorAll<HTMLElement>('.ti-cell'));
const input = () => screen.getByLabelText('作答') as HTMLInputElement;

afterEach(cleanup);

describe('TypingInput', () => {
  it('铺格：字母数字汉字一格一字，空格断词、符号是替你填好的固定格；键入的符号与多余的字不落格', () => {
    render(<Host answer="New York-2" />);
    expect(document.querySelectorAll('.ti-word')).toHaveLength(2);
    expect(cells().filter((c) => !c.classList.contains('fixed'))).toHaveLength(8);
    const fixed = cells().filter((c) => c.classList.contains('fixed'));
    expect(fixed.map((c) => c.textContent)).toEqual(['-']);
    expect(screen.getByText(/0\/8 字（空格与符号已替你填好）/)).toBeTruthy();

    fireEvent.change(input(), { target: { value: 'new-yorkers99' } });
    expect(screen.getByTestId('full').textContent).toBe('new york-e');
    expect(screen.getByText(/8\/8 字/)).toBeTruthy();
    expect(cells().filter((c) => c.classList.contains('filled'))).toHaveLength(8);
    expect(cells().some((c) => c.classList.contains('ok') || c.classList.contains('bad'))).toBe(false);
  });

  it('提示按段揭：未打的格显灰字（仍要自己打），揭完按钮停用；换题提示归零', () => {
    const view = render(<Host answer="事件循环" />);
    const btn = () => screen.getByRole('button', { name: /提示/ });
    expect(btn().textContent).toBe('提示 0/2');
    fireEvent.click(btn());
    expect(cells().filter((c) => c.classList.contains('ghost')).map((c) => c.textContent)).toEqual(['事', '件']);
    expect(screen.getByTestId('full').textContent).toBe('');
    fireEvent.change(input(), { target: { value: '事' } });
    expect(cells().filter((c) => c.classList.contains('ghost')).map((c) => c.textContent)).toEqual(['件']);
    fireEvent.click(btn());
    expect(btn().textContent).toBe('提示已用完');
    expect((btn() as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<Host answer="递归" />);
    expect(screen.getByRole('button', { name: /提示/ }).textContent).toBe('提示 0/1');
  });

  it('liveCheck 才逐格判对错（不分大小写）；正经考题不开就只有填没填', () => {
    render(<Host answer="New York" liveCheck />);
    fireEvent.change(input(), { target: { value: 'nEx' } });
    expect(cells().slice(0, 3).map((c) => (c.classList.contains('ok') ? 'ok' : c.classList.contains('bad') ? 'bad' : '-'))).toEqual(['ok', 'ok', 'bad']);
  });

  it('输入法组字期间不回写，组字结束才落格；回车提交（组字中的回车不算）', () => {
    const onSubmit = vi.fn();
    render(<Host answer="闭包" onSubmit={onSubmit} />);
    const el = input();
    fireEvent.compositionStart(el);
    fireEvent.change(el, { target: { value: 'bibao' } });
    expect(screen.getByTestId('full').textContent).toBe('');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    el.value = '闭包';
    fireEvent.compositionEnd(el);
    expect(screen.getByTestId('full').textContent).toBe('闭包');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('点格子 = 聚焦真输入框；禁用后不再给提示按钮', () => {
    const view = render(<Host answer="递归" />);
    fireEvent.mouseDown(document.querySelector('.ti-cells') as HTMLElement);
    expect(document.activeElement).toBe(input());
    view.rerender(
      <TypingInput answer="递归" value="递归" onChange={() => undefined} disabled ariaLabel="作答" />,
    );
    expect(screen.queryByRole('button', { name: /提示/ })).toBeNull();
    expect(input().disabled).toBe(true);
    expect(cells().filter((c) => c.classList.contains('filled')).map((c) => c.textContent)).toEqual(['递', '归']);
  });
});
