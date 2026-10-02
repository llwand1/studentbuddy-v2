/**
 * mobile.css 的结构锁（契约 docs/MOBILE-SPEC.md §4）。jsdom 无布局，锁的是「规则还在、且在正确的位置」：
 *  ① main.tsx 里 mobile.css 是**最后一个** CSS 引入（层叠靠顺序，挪到前面整文件静默失效）；
 *  ② index.html 的 viewport 带 viewport-fit=cover（没有它 env(safe-area-inset-*) 恒为 0）；
 *  ③ 四条口径各有对应规则：底部安全区（chat-view / coach-dock-rail）、粗指针 36px、手机表单 16px、字号下限 12px；
 *  ④ 本文件只写 ≤700 / 粗指针 / 矮屏三类媒体查询，不混进桌面规则。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

describe('mobile.css 结构锁', () => {
  it('① main.tsx 最后一个样式引入是 mobile.css', () => {
    const imports = [...main.matchAll(/import '([^']+\.css)';/g)].map((m) => m[1] ?? '');
    expect(imports.at(-1)).toBe('./styles/mobile.css');
  });
  it('② viewport-fit=cover', () => {
    expect(html).toMatch(/name="viewport" content="[^"]*viewport-fit=cover/);
  });
  it('③ 四条口径各有规则', () => {
    expect(css).toMatch(/\.chat-view\s*\{[^}]*env\(safe-area-inset-bottom/);
    expect(css).toMatch(/\.coach-dock-rail\s*\{[^}]*env\(safe-area-inset-bottom/);
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*min-height: 36px/);
    expect(css).toMatch(/body textarea,\s*body select \{\s*font-size: 16px/);
    expect(css).toMatch(/--sb-fs-xs: 12px/);
  });
  it('④ 只有手机 / 粗指针 / 矮屏三类媒体查询', () => {
    const queries = [...css.matchAll(/@media ([^{]+)\{/g)].map((m) => (m[1] ?? '').trim());
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q).toMatch(/max-width: (700|900)px|pointer: coarse/);
  });
});
