// @vitest-environment jsdom
/**
 * FillBlank —— 对话出题的一个填空该长什么样（2026-09-30）：参考答案短（≤24 格、可打字符 ≥70%）⇒ 逐格打字控件，
 * 且可切「自由输入」回普通框（切换清空作答）；整句 / 满是符号 / 没参考答案 ⇒ 普通框；两种框回车都能提交。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { FillBlank } from './FillBlank';

function Host({ expected, onEnter }: { expected: string | undefined; onEnter?: () => void }) {
  const [v, setV] = useState('');
  return (
    <div>
      <FillBlank expected={expected} value={v} onChange={setV} disabled={false} label="第 1 空" placeholder="输入" {...(onEnter ? { onEnter } : {})} />
      <output data-testid="full">{v}</output>
    </div>
  );
}

afterEach(cleanup);

describe('FillBlank', () => {
  it('短答案 ⇒ 逐格打字（符号格替你填好）；「自由输入」切回普通框并清空', () => {
    render(<Host expected="New York" />);
    expect(document.querySelector('.ti-cells')).not.toBeNull();
    expect(document.querySelector('input.quiz-fill')).toBeNull();
    fireEvent.change(screen.getByLabelText('第 1 空'), { target: { value: 'newyork' } });
    expect(screen.getByTestId('full').textContent).toBe('new york');
    fireEvent.click(screen.getByRole('button', { name: '自由输入' }));
    expect(document.querySelector('.ti-cells')).toBeNull();
    expect(screen.getByTestId('full').textContent).toBe('');
    fireEvent.change(screen.getByLabelText('第 1 空'), { target: { value: 'NYC (the big apple)' } });
    expect(screen.getByTestId('full').textContent).toBe('NYC (the big apple)');
  });

  it('整句 / 满是符号 / 没参考答案 ⇒ 普通框，没有「自由输入」钮；回车提交', () => {
    const onEnter = vi.fn();
    const long = render(<Host expected="加速度与合外力成正比、与质量成反比，方向与合外力相同" onEnter={onEnter} />);
    expect(document.querySelector('.ti-cells')).toBeNull();
    expect(screen.queryByRole('button', { name: '自由输入' })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText('第 1 空'), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);
    long.unmount();
    render(<Host expected="F = m × a" />);
    expect(document.querySelector('.ti-cells')).toBeNull();
    cleanup();
    render(<Host expected={undefined} />);
    expect(document.querySelector('.ti-cells')).toBeNull();
  });

  it('逐格模式下回车也提交', () => {
    const onEnter = vi.fn();
    render(<Host expected="闭包" onEnter={onEnter} />);
    fireEvent.keyDown(screen.getByLabelText('第 1 空'), { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});
