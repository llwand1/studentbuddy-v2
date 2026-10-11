// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MathText } from './MathText';
afterEach(cleanup);
it('题目选项显示真正分数与矩阵，不插入交互按钮或链接', () => {
  const {container}=render(<button><MathText text={'选 $\\frac{1}{2}$；\\(\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}\\)'}/></button>);
  expect(container.querySelectorAll('.katex')).toHaveLength(2);
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect(container.querySelector('a')).toBeNull();
});
it('独立推导可局部阅读，普通代码与价格保持原文，坏公式不猜答案', () => {
  const source='$$\\begin{aligned}x&=1\\\\y&=2\\end{aligned}$$';
  const {container,rerender}=render(<MathText text={source}/>);
  expect(container.querySelector('.math-text-display math')).not.toBeNull();
  const plain='价格 \\$5 / $10，`$x$`，```text\n$$x=1$$\n```';
  rerender(<MathText text={plain}/>);
  expect(container.querySelector('.katex')).toBeNull();
  expect(container.textContent).toBe(plain.replace('\\$','$'));
  rerender(<MathText text={'$\\unknown{x}$'}/>);
  expect(container.textContent).toBe('$\\unknown{x}$');
});
