// @vitest-environment jsdom
/**
 * Markdown.test — 助手正文渲染的组件级回归锁。
 *
 * 钉的是「数据结构 → DOM」这一层的真实行为：标题降级映射、内联格式、原始 HTML
 * 绝不成为活元素（全篇不 dangerouslySetInnerHTML 的契约）、任务列表只读勾选、
 * 长代码块折叠、```html 永不内联、流式高亮分档。纯解析逻辑在 lib/markdown.test.ts，
 * 这里只锁组件渲染（前端测试空白的一次补课，见 `docs/TEST-PLAN.md` §7）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Markdown } from './Markdown';

afterEach(cleanup);

const q = (c: HTMLElement, sel: string) => c.querySelector(sel);
const qa = (c: HTMLElement, sel: string) => Array.from(c.querySelectorAll(sel));

describe('Markdown 组件渲染', () => {
  it('公式流式完成及历史显示可读符号，未知命令保留源码且模型 HTML 不变成元素', () => {
    const text = '由 $2 \\times x = 16$ 得到：\n\n$$\\boxed{x = 16 \\div 2 = 8}$$';
    const {container,rerender}=render(<Markdown text={text} streaming />);
    expect(q(container,'.math-inline .katex-html')?.textContent?.replace(/\s/g,'')).toContain('2×x=16');
    expect(q(container,'.math-paper .katex-html')?.textContent?.replace(/\s/g,'')).toContain('x=16÷2=8');
    expect(q(container,'.math-paper math')).not.toBeNull();
    const shown=container.textContent;rerender(<Markdown text={text}/>);expect(container.textContent).toBe(shown);
    rerender(<Markdown text={'$$\\unknown{<img src=x onerror=x>}$$'}/>);
    expect(q(container,'details summary')?.textContent).toContain('保留原式');
    expect(container.textContent).toContain('\\unknown');expect(q(container,'img')).toBeNull();
    rerender(<Markdown text={'$$\\frac{x'} streaming/>);expect(container.textContent).toContain('正在书写公式');
  });
  it('答案纸支持对齐推导、原式复制和主动放大，卡片/表格/列表复用数学通道', async () => {
    const formula = '\\begin{aligned}2x-2&=10\\\\2x&=12\\\\x&=6\\end{aligned}';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const text = `> [!STEP] 逐步求解\n> $$${formula}$$\n\n- 用 $\\frac{1}{2}$ 检查。\n\n|量|值|\n|---|---|\n|根|\\(\\sqrt{2}\\)|`;
    const { container } = render(<Markdown text={text} />);
    expect(q(container,'.learning-reply-step .math-paper[aria-label="逐行推导"]')).not.toBeNull();
    expect(qa(container, 'li .katex, td .katex')).toHaveLength(2);
    const buttons = qa(container, '.math-paper button');
    fireEvent.click(buttons[0]!);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(formula));
    fireEvent.click(buttons[1]!);
    expect(q(container, '.math-paper-large')).not.toBeNull();
    expect(buttons[1]?.getAttribute('aria-pressed')).toBe('true');
  });
  it('学习卡流式与历史呈现一致，支持安全的正文/链接且不把模型 HTML 变成元素', () => {
    const src = '> [!CORE] 牛顿第二定律\n> **合力**导致加速度。\n> 关键词：`合力` · `质量`\n\n> [!PITFALL] 看清条件\n> <img src=x onerror=alert(1)> [来源](javascript:evil())\n\n```svg\n<svg viewBox="0 0 680 480"><text fill="black">合力</text></svg>\n```';
    const { container, rerender } = render(<Markdown text={src} streaming />);
    const first = container.textContent;
    expect(q(container, 'section[aria-label="核心结论"] strong')?.textContent).toBe('合力');
    expect(qa(container, '.learning-reply-card')).toHaveLength(2);
    expect(q(container, '.learning-reply-pitfall')?.textContent).toContain('<img');
    expect(q(container, '.learning-reply-pitfall img')).toBeNull();
    expect(q(container, '.learning-reply-pitfall a')).toBeNull();
    expect(q(container, '.chat-svg-canvas svg rect')?.getAttribute('fill')).toBe('#ffffff');
    expect(q(container, '.chat-svg-canvas-wide[role="region"]')).not.toBeNull();
    expect(q(container, '.chat-svg-hint')?.textContent).toContain('横向滑动');
    rerender(<Markdown text={src} />);
    expect(container.textContent).toBe(first);
    expect(qa(container, '.learning-reply-card')).toHaveLength(2);
    expect(container.textContent).not.toContain('[!CORE]');
    const separate = '> [!STEP] 1. 展开括号\n\n把 2 乘到每一项。\n\n> [!STEP] 思路小结\n\n| 操作 | 依据 |\n|---|---|\n| 展开 | 分配律 |';
    rerender(<Markdown text={separate} streaming />);
    expect(qa(container, '.learning-reply-step')).toHaveLength(2);
    expect(container.textContent).not.toContain('[!STEP]');
    expect(container.textContent).toContain('把 2 乘到每一项');
    expect(q(container, 'table')?.textContent).toContain('分配律');
    const headings = container.textContent;
    rerender(<Markdown text={separate} />);
    expect(container.textContent).toBe(headings);
  });
  it('流式及历史回读中，解释后的步骤与子步骤编号由源文本决定', () => {
    const text = '1. 去括号\n\n为什么：展开后才能合并。\n\n2. 合并\n  4. 子步骤\n\n3. 移项';
    const { container, rerender } = render(<Markdown text={text} streaming />);
    const starts = () => (qa(container, 'ol') as HTMLOListElement[]).map((ol) => ol.start);
    expect(starts()).toEqual([1, 2, 4, 3]);
    rerender(<Markdown text={text} />);
    expect(starts()).toEqual([1, 2, 4, 3]);
    rerender(<Markdown text={'- 没有编号'} />);
    expect(q(container, 'ul')?.hasAttribute('start')).toBe(false);
  });
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

  it('正文图片按 img 渲染，且带 lazy 与 no-referrer', () => {
    const { container } = render(<Markdown text={'看图 ![流程图](https://a.example/x.png) 就懂'} />);
    const img = q(container, 'img.md-img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://a.example/x.png');
    expect(img?.getAttribute('alt')).toBe('流程图');
    expect(img?.getAttribute('loading')).toBe('lazy');
    // 图片地址是模型给的，不该顺手把用户侧来源带给第三方
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('危险协议的图片既不出 img，也不把原始记号糊在屏幕上', () => {
    const { container } = render(<Markdown text={'![说明](javascript:alert(1))'} />);
    expect(q(container, 'img')).toBeNull();
    expect(container.textContent).toContain('说明');
    expect(container.textContent).not.toContain('javascript');
  });

  it('流式半截图片不留内部占位串，也不出破图（闭合前显示 alt 文字）', () => {
    const { container } = render(<Markdown text={'看图 ![流程图](https://a.example/x'} streaming />);
    expect(q(container, 'img')).toBeNull();
    expect(container.textContent).not.toContain('sb:incomplete-image');
    expect(container.textContent).toContain('流程图');
  });
});
