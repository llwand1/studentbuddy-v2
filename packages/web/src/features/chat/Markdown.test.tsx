// @vitest-environment jsdom
/**
 * Markdown.test — 助手正文渲染的组件级回归锁。
 *
 * 钉的是「数据结构 → DOM」这一层的真实行为：标题降级映射、内联格式、原始 HTML
 * 绝不成为活元素（全篇不 dangerouslySetInnerHTML 的契约）、任务列表只读勾选、
 * 长代码块折叠、```html 永不内联、流式高亮分档。纯解析逻辑在 lib/markdown.test.ts，
 * 这里只锁组件渲染（前端测试空白的第一批补课，见 test-plan §7）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Markdown } from './Markdown';

afterEach(cleanup);

const q = (c: HTMLElement, sel: string) => c.querySelector(sel);
const qa = (c: HTMLElement, sel: string) => Array.from(c.querySelectorAll(sel));

describe('Markdown 组件渲染', () => {
  it('标题按级降档：#→h3、##→h4、###及更深→h5（5/6 级收敛到 4 级字号）', () => {
    const { container } = render(<Markdown text={'# 一\n\n## 二\n\n### 三\n\n##### 五'} />);
    expect(q(container, 'h3.md-h1')?.textContent).toContain('一');
    expect(q(container, 'h4.md-h2')?.textContent).toContain('二');
    expect(qa(container, 'h5.md-h3').length).toBe(2); // ### 与 ##### 同档
  });

  it('内联格式齐全，链接强制新标签 + noreferrer', () => {
    const { container } = render(
      <Markdown text={'**粗** *斜* ~~删~~ `码` [站](https://example.com)'} />,
    );
    expect(q(container, 'strong')?.textContent).toBe('粗');
    expect(q(container, 'em')?.textContent).toBe('斜');
    expect(q(container, 'del')?.textContent).toBe('删');
    expect(q(container, 'code.md-inline-code')?.textContent).toBe('码');
    const a = q(container, 'a') as HTMLAnchorElement | null;
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('原始 HTML 只作为文本渲染，不产生活元素（无注入点契约）', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const { container } = render(<Markdown text={evil} />);
    expect(q(container, 'script')).toBeNull();
    expect(q(container, 'img')).toBeNull();
    expect(container.textContent).toContain(evil); // 原文可见，不是被悄悄吞掉
  });

  it('任务列表渲染为只读 checkbox，勾选态跟随源文本', () => {
    const { container } = render(<Markdown text={'- [x] 已完成\n- [ ] 待办'} />);
    const boxes = qa(container, 'input.md-task-box') as HTMLInputElement[];
    expect(boxes.length).toBe(2);
    expect(boxes[0]?.checked).toBe(true);
    expect(boxes[1]?.checked).toBe(false);
    expect(boxes[0]?.readOnly).toBe(true); // 展示件，不可交互改态
  });

  it('表格渲染 thead/tbody 且单元格过内联解析', () => {
    const { container } = render(
      <Markdown text={'| 甲 | 乙 |\n|---|---|\n| **1** | 2 |'} />,
    );
    const ths = qa(container, 'thead th');
    expect(ths.map((t) => t.textContent)).toEqual(['甲', '乙']);
    expect(q(container, 'tbody td strong')?.textContent).toBe('1');
  });

  it('复制按钮写剪贴板并回显「已复制」（413 之外 composer 侧的另一半体验）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { container } = render(
      <Markdown text={'```ts\nconst a = 1;\n```'} />,
    );
    const btn = qa(container, 'button.md-pre-btn').find((b) => b.textContent === '复制');
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('const a = 1;');
      expect(btn!.textContent).toBe('已复制');
    });
  });

  it('超过 25 行的代码块默认折叠，点「展开全部 N 行」放开', () => {
    const code = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const { container } = render(<Markdown text={'```\n' + code + '\n```'} />);
    const pre = q(container, 'pre')!;
    expect(pre.className).toContain('md-pre-folded');
    const toggle = q(container, 'button.md-pre-toggle')!;
    expect(toggle.textContent).toBe('展开全部 30 行'); // 行数直给，不让人猜藏了多少
    fireEvent.click(toggle);
    expect(pre.className).not.toContain('md-pre-folded');
    expect(q(container, 'button.md-pre-toggle')!.textContent).toBe('收起');
  });

  it('流式中代码块长过 25 行当场就该折；用户手动展开后不再被拉回折叠', () => {
    const el = document.createElement('div');
    const code = (n: number) => '```python\n' + Array.from({ length: n }, (_, i) => `line${i}`).join('\n');
    const r = render(<Markdown text={code(5)} streaming />, { container: el });
    expect(q(el, 'pre')!.className).not.toContain('md-pre-folded'); // 短块不该有折叠条
    // 流到 30 行的这一帧就要折：旧实现只在挂载时求值一次，会一路全展开
    r.rerender(<Markdown text={code(30)} streaming />);
    expect(q(el, 'pre')!.className).toContain('md-pre-folded');
    // 手动放开之后，继续流入也不许跟用户抢状态
    fireEvent.click(q(el, 'button.md-pre-toggle')!);
    r.rerender(<Markdown text={code(40)} streaming />);
    expect(q(el, 'pre')!.className).not.toContain('md-pre-folded');
  });

  it('```html 围栏永不内联：无 iframe、原文不成为活元素，只给卡片入口', () => {
    const { container } = render(
      <Markdown text={'```html\n<b>粗体</b>\n```'} />,
    );
    expect(q(container, 'iframe')).toBeNull();
    expect(q(container, 'b')).toBeNull(); // HtmlCard 不渲染原文 DOM
  });

  it('流式未闭合代码块按「已完整行」出高亮档，语言标先行显示', () => {
    const { container } = render(
      <Markdown text={'```python\nprint("a")\nfor i in ra'} streaming />,
    );
    expect(q(container, '.md-pre-lang')?.textContent).toBe('python');
    expect(container.textContent).toContain('print("a")');
    // 未闭合围栏不整块重刷：已完整行进入高亮 span
    expect(qa(container, 'code span[class^="hl-"]').length).toBeGreaterThan(0);
  });

  it('流式渲染不吞字符：每帧 rerender 后全文可读', () => {
    const el = document.createElement('div');
    const r = render(<Markdown text={'para 第一行'} streaming />, { container: el });
    r.rerender(<Markdown text={'para 第一行\n\n## 第二标题'} streaming />);
    expect(el.textContent).toContain('para 第一行');
    expect(q(el, 'h4.md-h2')?.textContent).toContain('第二标题');
  });
});
