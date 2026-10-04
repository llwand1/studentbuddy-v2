/**
 * reading.css 的结构锁（契约 `docs/READING-SIZE-SPEC.md`）。与 `mobile.test.ts` 同型同理由：
 * jsdom 无布局，量不出「字真的变大了」，但能锁住「规则还在、且在能生效的位置」——
 * 纯 CSS 的功能最容易在后续改版里被**静默**改没（没有报错、没有红灯，只是不生效了）：
 *   ① 四个档位各有 `:root[data-reading=…]`（少一档 ⇒ 那一档点了没反应，而且不报错）；
 *   ② 阅读区重定义了 `--sb-fs-md`（整套缩放的发动机，被删只剩外壳）；
 *   ③ `.term-def` 的 13px 走缩放（terms.css 里写死过一次，复发就等于大号对它无效）；
 *   ④ `reading.css` 被 main.tsx 引入，且排在 `mobile.css` 之前、功能样式之后。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { READING_SIZES } from '../lib/reading-prefs';

const css = readFileSync(new URL('./reading.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const imports = [...main.matchAll(/import '([^']+\.css)';/g)].map((m) => m[1] ?? '');

describe('reading.css 结构锁', () => {
  it('① 每个档位都有对应的 :root[data-reading=…] 规则', () => {
    for (const o of READING_SIZES) {
      expect(css).toMatch(new RegExp(`:root\\[data-reading='${o.id}'\\]`));
    }
  });

  it('② 阅读区重定义了 --sb-fs-md，且作用域含 .chat-bubble 与 .term-def', () => {
    expect(css).toMatch(/--sb-fs-md:\s*calc\(14px \* var\(--sb-reading-scale\)\)/);
    expect(css).toContain('.chat-bubble');
    expect(css).toContain('.term-def');
  });

  it('③ .term-def 的 13px 走缩放（terms.css 里写死过，复发＝大号对词条无效）', () => {
    expect(css).toMatch(/font-size:\s*calc\(13px \* var\(--sb-reading-scale\)\)/);
  });

  it('④ main.tsx 引入 reading.css，且在 mobile.css 之前', () => {
    expect(imports).toContain('./styles/reading.css');
    expect(imports.indexOf('./styles/reading.css')).toBeLessThan(imports.indexOf('./styles/mobile.css'));
  });

  it('④ 启动时调用 initReadingSize（否则刷新后回到标准档，设置像是没存上）', () => {
    expect(main).toMatch(/initReadingSize\(\)/);
  });
});
