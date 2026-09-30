/**
 * guide-layout 单测：`<main>` 的类名口径（契约 `docs/GUIDE-SPEC.md` §8「位置」）。
 * 通栏页（知识大陆）内容顶着主区左边缘，要让出灯笼轨；其余三页左侧本来就有空白。
 * 另锁一条「CSS 与常量对得上」：`guide.css` 里确实有 `.guide-rail` 与 `.has-guide` 的让位规则，
 * 不会出现「类名加了、样式被谁删了」的静默失效。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE_RAIL_VIEWS, guideMainClass } from './guide-layout';

describe('guideMainClass', () => {
  it('所有视图都带 sb-main 与 has-guide；只有通栏页多一个 guide-rail', () => {
    for (const v of ['chat', 'terms', 'settings'] as const) expect(guideMainClass(v)).toBe('sb-main has-guide');
    for (const v of ['continent'] as const) expect(guideMainClass(v)).toBe('sb-main has-guide guide-rail');
    expect(GUIDE_RAIL_VIEWS).toEqual(['continent']);
  });

  it('guide.css 里有对应的让位规则（窄屏档 + 通栏页档），都用 --sb-guide-rail', () => {
    const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'guide.css'), 'utf8');
    expect(css).toMatch(/\.sb-main\.has-guide\s*\{\s*padding-left:\s*var\(--sb-guide-rail\)/);
    expect(css).toMatch(/\.sb-main\.guide-rail\s*\{\s*padding-left:\s*var\(--sb-guide-rail\)/);
    expect(css).toMatch(/max-width:\s*1199px/);
  });
});
