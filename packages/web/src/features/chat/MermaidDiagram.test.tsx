// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MermaidDiagram } from './MermaidDiagram';
import { normalizeDiagramSource, renderDiagram, safeDiagramSource, uniqueDiagramIds } from '../../lib/diagram-render';
import { diagramSvg } from '../../lib/diagram-svg';
import { prepareSvg } from '../../lib/svg-utils';

const fake = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: fake }));
afterEach(cleanup);
const svg = '<svg id="root" viewBox="0 0 300 120"><defs><marker id="arrow"><path d="M0 0L2 2"/></marker></defs><path marker-end="url(#arrow)"/><text>起点</text></svg>';

describe('自动布局图解', () => {
  it('未闭合不加载，闭合才布局；相同图复用但每张图 ID 独立', async () => {
    fake.render.mockResolvedValue({ svg });
    const code = 'flowchart TD\nA[起点]-->B[终点]';
    const { container, rerender } = render(<MermaidDiagram code={code} closed={false}/>);
    expect(container.textContent).toContain('正在书写');
    expect(fake.render).not.toHaveBeenCalled();
    rerender(<><MermaidDiagram code={code} closed/><MermaidDiagram code={code} closed/></>);
    await vi.waitFor(() => expect(container.querySelectorAll('.chat-svg-canvas svg')).toHaveLength(2));
    expect(fake.render).toHaveBeenCalledTimes(1);
    expect(fake.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel:'strict', htmlLabels:false, maxEdges:160 }));
    const ids = Array.from(container.querySelectorAll('[id]')).map(node=>node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(container.textContent).toContain('知识图解');
  });
  it('危险配置与资源在创建临时 DOM 之前拒绝，保留源码', async () => {
    for (const source of ['%%{init: {securityLevel:"loose"}}%%\nflowchart TD', '---\nconfig:\n theme: dark\n---\nflowchart TD', 'flowchart TD\nA@{img:"https://evil/x"}', 'flowchart TD\nclick A "https://evil"', 'flowchart TD\nA[<img src=x>]']) {
      expect(safeDiagramSource(source)).toBe(false);
      await expect(renderDiagram(source)).rejects.toThrow();
    }
    const { container } = render(<MermaidDiagram code={'flowchart TD\nA[<script>]'} closed/>);
    await vi.waitFor(() => expect(container.textContent).toContain('保留原文'));
    expect(container.querySelector('script')).toBeNull();
  });
  it('切换内容忽略迟到图解，失败回退后仍可重新生成', async () => {
    let complete: ((v:{svg:string})=>void) | undefined;
    fake.render.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const { container, rerender } = render(<MermaidDiagram code="flowchart TD\nold-->slow" closed/>);
    await vi.waitFor(()=>expect(complete).toBeDefined());
    fake.render.mockRejectedValueOnce(new Error('syntax'));
    rerender(<MermaidDiagram code="invalid diagram" closed/>);
    await vi.waitFor(()=>expect(container.textContent).toContain('保留原文'));
    complete?.({svg});
    await Promise.resolve();
    expect(container.querySelector('svg')).toBeNull();
    fake.render.mockResolvedValueOnce({svg});
    await expect(renderDiagram('invalid diagram')).resolves.toContain('起点');
  });
  it('所有片段引用与 CSS 选择器随 ID 改名，箭头引用保留', () => {
    const unique = uniqueDiagramIds(svg+'<style>#root .x{fill:red}</style>','copy');
    expect(unique).toContain('id="arrow-copy"');
    expect(unique).toContain('url(#arrow-copy)');
    expect(unique).toContain('#root-copy .x');
    const normalized = diagramSvg(svg.replace('<defs>', '<style>@keyframes dash{to{stroke-dashoffset:0;}}#root text{fill:#202c3a;font-size:18px}</style><defs>'));
    const safe = prepareSvg(normalized);
    expect(safe).toContain('<style>');
    expect(safe).not.toContain('@keyframes');
    expect(safe).toContain('font-size:18px');
    const duplicates = uniqueDiagramIds('<svg id="root"><path id="node"/><g id="node"/></svg>','copy');
    expect(duplicates).toContain('id="node-copy-1"');
    expect(normalizeDiagramSource('flowchart TD\nA[原式 2(x-3)+4=10] --> B[验算]')).toBe('flowchart TD\nA["原式 2(x-3)+4=10"] --> B["验算"]');
    expect(normalizeDiagramSource('flowchart TD\nA["已加引号"]')).toBe('flowchart TD\nA["已加引号"]');
  });
});
