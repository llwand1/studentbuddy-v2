// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '../../../../../tools/browser-extension/extract.js';
const read = () => (globalThis as unknown as { studentBuddyReadPage: () => { text: string; selection: string; viewport: string } }).studentBuddyReadPage();
beforeEach(() => {
  document.body.innerHTML = '<nav>菜单</nav><main><article><h1>光合作用</h1><p id="lesson">光反应产生氧气。</p><p>叶绿体的类囊体</p><p hidden>隐藏密钥</p><form><input value="password"><textarea>私有草稿</textarea></form><div contenteditable="true">编辑中的私有笔记</div><aside>广告</aside><script>secret()</script></article></main><footer>页脚</footer>';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 1, y: 10, width: 300, height: 40, top: 10, bottom: 50, left: 1, right: 301, toJSON: () => ({}) });
});
afterEach(() => { vi.restoreAllMocks(); getSelection()?.removeAllRanges(); document.body.innerHTML = ''; });
it('extracts live article text, current viewport and safe selections while excluding private inputs and chrome', () => {
  const range = document.createRange(); range.selectNodeContents(document.getElementById('lesson')!);
  getSelection()?.addRange(range);
  const result = read(); expect(result.text).toContain('类囊体'); expect(result.viewport).toContain('产生氧气'); expect(result.selection).toBe('光反应产生氧气。');
  for (const excluded of ['菜单', '隐藏密钥', 'password', '私有草稿', '私有笔记', '广告', 'secret', '页脚']) expect(result.text).not.toContain(excluded);
  document.getElementById('lesson')!.textContent = '修订后的光反应'; expect(read().text).toContain('修订后'); expect(read().text).not.toContain('产生氧气');
});
it('caps large pages and refuses selected text from editable or hidden elements', () => {
  const range = document.createRange(); range.selectNodeContents(document.querySelector('[contenteditable]')!); getSelection()?.addRange(range);
  expect(read().selection).toBe('');
  getSelection()?.removeAllRanges(); range.selectNodeContents(document.querySelector('article')!); getSelection()?.addRange(range);
  const selected = read().selection; expect(selected).toContain('光反应');
  for (const excluded of ['隐藏密钥', '私有草稿', '私有笔记', '广告', 'secret']) expect(selected).not.toContain(excluded);
  const p = document.createElement('p'); p.textContent = 'x'.repeat(180000); document.querySelector('article')!.append(p);
  expect(read().text.length).toBeLessThanOrEqual(120000); expect(read().viewport.length).toBeLessThanOrEqual(6000);
});
