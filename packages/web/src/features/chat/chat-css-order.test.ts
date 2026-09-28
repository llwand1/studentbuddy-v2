/**
 * chat-css-order.test — 对话页两份样式的「顺序契约」锁。
 *
 * 背景（2026-09-28 真机逮到）：`chat.css` 写 `.chat-step{display:flex}`、`chat-extras.css` 写
 * `.chat-step{display:block}` 想覆盖它——但两份文件谁先进产物取决于模块图（chat.css 由 ChatView
 * 引入、chat-extras.css 由面板组件引入，而 ChatView 先 import 面板组件），结果 chat.css 排在后面、
 * flex 赢，展开的工具载荷跑到行头右侧。这类退化**零运行时错误、jsdom 看不见布局**，只能锁源头：
 *   ① 两份文件对同一选择器**不得二次声明同一属性**（同值也不许——那是在埋下一次赌顺序的种子）；
 *   ② ChatView 里 `import './chat.css'` 必须排在所有本目录组件 import 之前（底层先进产物）。
 * 解析器是刻意的最小实现：只看顶层规则与 @media 内的规则，够用且不引依赖。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = join(__dirname);
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8');

type Decls = Record<string, string>;

/** 极简 CSS 规则抽取：返回 [选择器, 声明表]，@keyframes 内的帧不算规则 */
export function extractRules(css: string): Array<[string, Decls]> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Array<[string, Decls]> = [];
  const stack: string[] = [];
  let cur = '';
  for (const ch of src) {
    if (ch === '{') {
      stack.push(cur.trim());
      cur = '';
    } else if (ch === '}') {
      const sel = stack.pop() ?? '';
      const insideKeyframes = stack.some((s) => s.startsWith('@keyframes'));
      if (sel && !sel.startsWith('@') && !insideKeyframes) {
        const decls: Decls = {};
        for (const d of cur.split(';')) {
          const i = d.indexOf(':');
          if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
        if (Object.keys(decls).length > 0) {
          for (const one of sel.split(',')) out.push([one.trim(), decls]);
        }
      }
      cur = '';
    } else {
      cur += ch;
    }
  }
  return out;
}

function mergeBySelector(rules: Array<[string, Decls]>): Map<string, Decls> {
  const m = new Map<string, Decls>();
  for (const [sel, decls] of rules) m.set(sel, { ...(m.get(sel) ?? {}), ...decls });
  return m;
}

describe('chat.css × chat-extras.css：同选择器不二次声明同一属性', () => {
  it('解析器能读出规则与声明（自检，防止「解析出 0 条 ⇒ 空集合天然通过」）', () => {
    const rules = extractRules('.a { color: red; } @media (x) { .b { top: 0 } } @keyframes k { to { opacity: 1 } }');
    expect(rules).toEqual([
      ['.a', { color: 'red' }],
      ['.b', { top: '0' }],
    ]);
    expect(extractRules(read('chat.css')).length).toBeGreaterThan(20);
    expect(extractRules(read('chat-extras.css')).length).toBeGreaterThan(20);
  });

  it('两份文件共有的选择器上，没有任何一个属性被两边同时声明', () => {
    const base = mergeBySelector(extractRules(read('chat.css')));
    const extra = mergeBySelector(extractRules(read('chat-extras.css')));
    const overlaps: string[] = [];
    for (const [sel, decls] of base) {
      const other = extra.get(sel);
      if (!other) continue;
      for (const prop of Object.keys(decls)) {
        if (prop in other) overlaps.push(`${sel} { ${prop}: ${decls[prop]} | ${other[prop]} }`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('.chat-step 在基础层就是块容器（行由 .chat-step-row 承担），扩展层不再改写它的 display', () => {
    const base = mergeBySelector(extractRules(read('chat.css')));
    const extra = mergeBySelector(extractRules(read('chat-extras.css')));
    expect(base.get('.chat-step')?.display).toBe('block');
    expect(extra.get('.chat-step')?.display).toBeUndefined();
    expect(extra.get('.chat-step-row')?.display).toBe('flex');
  });
});

describe('ChatView：基础样式先于本目录组件进模块图', () => {
  it("`import './chat.css'` 排在第一个 `from './…'` 组件 import 之前", () => {
    const src = read('ChatView.tsx');
    const cssAt = src.indexOf("import './chat.css'");
    const firstLocal = src.search(/from '\.\/[A-Za-z]/);
    expect(cssAt).toBeGreaterThanOrEqual(0);
    expect(firstLocal).toBeGreaterThan(0);
    expect(cssAt).toBeLessThan(firstLocal);
  });
});
