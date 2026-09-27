// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Welcome } from './Welcome';

afterEach(cleanup);
describe('pixel welcome', () => {
  it('keeps four usable prompts and sends exactly the selected draft to the composer', () => {
    const pick = vi.fn();
    render(<Welcome onPick={pick} />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(pick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /问个概念/ }));
    expect(pick).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledWith('用一句话讲清楚什么是向量数据库，再举一个学习场景里的例子');
  });
  it('keeps scene decorations out of the accessibility tree and interactive order', () => {
    const { container } = render(<Welcome onPick={vi.fn()} />);
    const scene = container.querySelector('.pixel-scene');
    expect(scene?.getAttribute('aria-hidden')).toBe('true');
    expect(scene?.querySelectorAll('button, a, input, [tabindex="0"]')).toHaveLength(0);
    expect(screen.getByText('今天想学点什么？')).toBeTruthy();
  });
});
