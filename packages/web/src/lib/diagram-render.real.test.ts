// @vitest-environment jsdom
import { expect, it } from 'vitest';
import mermaid from 'mermaid';
import { normalizeDiagramSource, safeDiagramSource } from './diagram-render';
mermaid.initialize({ startOnLoad:false, securityLevel:'strict', htmlLabels:false });
it('real Mermaid accepts recent color/linebreak/sequence patterns, not just a mocked renderer', async () => {
  const examples = [
    'flowchart TD\nA["普通表\\n父子关系"] --> B["查路径？\\n递归遍历"]\nC["闭包表"] --> D["直接查询"]\nstyle B fill:#ffebee,stroke:#c62828\nstyle D fill:#e8f5e9,stroke:#2e7d32',
    'graph LR\nA[电路]-->B[硬件]\nclassDef marked fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px\nclass B marked',
    'sequenceDiagram\nparticipant 学生\nparticipant 导师\n学生->>导师: 提问\n导师-->>学生: 解答\n学生->>导师: 练习',
    'flowchart TD\nA[原式 2(x-3)+4=10] --> B[验算]',
  ];
  for (const source of examples) { expect(safeDiagramSource(source)).toBe(true); await expect(mermaid.parse(normalizeDiagramSource(source))).resolves.toBeTruthy(); }
});
it('styles cannot hide network loads, arbitrary CSS, config or HTML', () => {
  for (const source of ['flowchart TD\nstyle A fill:url(https://evil/x)', 'flowchart TD\nstyle A background:red',
    'flowchart TD\nstyle A fill:#fff;click A "https://evil"', 'flowchart TD\nclassDef x fill:expression(x)',
    'flowchart TD\nA[<br onload=x>]', 'flowchart TD\nA[<a href=x>]']) expect(safeDiagramSource(source)).toBe(false);
});
