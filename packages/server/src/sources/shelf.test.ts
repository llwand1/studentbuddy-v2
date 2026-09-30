/**
 * sources/shelf 单测（契约 docs/SOURCE-TRACE-SPEC.md §4）。
 *
 * 钉：① 编号全轮唯一、跨搜索续号、同网址复用；② 每次搜索只上架前 5 条但**全部占号**；
 * ③ 未上架的结果被 fetch_page 读到时以**原号**上架（read 档）；④ 架满挤 search 不挤 read/pick；
 * ⑤ pick 只认架上（known）网址、多余的截到 3 条、未知的原样退回；⑥ 每次变化整表下发 block 帧、
 * 且 `readingN` 只在读取中有值；⑦ 非 http(s) 一律不占号不上架；⑧ 在线注册表可查 knows；
 * ⑨（2026-09-30）读失败撤占位／退回 search 档；⑩ `settle` 收口只留读成功 / 精选 / 正文引用到的，编号不动。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SearchResult } from '../search/types.js';

const published: Array<{ type: string; blockId?: string; payload?: unknown }> = [];
vi.mock('../chat/sse-bus.js', () => ({
  publish: (_sid: string, ev: { type: string; blockId?: string; payload?: unknown }) => {
    published.push(ev);
    return published.length;
  },
}));

const { createSourceShelf, liveShelfKnows, normalizeSourceUrl } = await import('./shelf.js');

const results = (n: number, prefix = 'a'): SearchResult[] =>
  Array.from({ length: n }, (_, i) => ({
    title: `标题${prefix}${i + 1}`,
    url: `https://${prefix}.example.com/p/${i + 1}`,
    snippet: `摘要${i + 1}`,
    source: 'bing',
  }));

const lastPayload = () => published[published.length - 1]?.payload as { items: Array<{ n: number; origin: string; title: string }>; readingN?: number };

beforeEach(() => {
  published.length = 0;
});

describe('shelf：编号与上架', () => {
  it('① 跨搜索续号、同网址复用同一号；② 每次只上架前 5 条但全部占号', () => {
    const shelf = createSourceShelf('s1');
    expect(shelf.found('q1', results(7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(shelf.items().map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    // 第二次搜索：新网址从 8 起；第 1 条与上次的第 1 条同网址 ⇒ 复用 1
    const again = [results(1)[0]!, ...results(3, 'b')];
    expect(shelf.found('q2', again)).toEqual([1, 8, 9, 10]);
    expect(shelf.items().map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 8, 9, 10]);
    expect(shelf.items()[0]?.query).toBe('q1');
  });

  it('③ 未上架的第 6 条被读到时以原号 6 上架为 read 档；读取中 readingN=6，读完清掉并补标题', () => {
    const shelf = createSourceShelf('s2');
    shelf.found('q', results(7));
    shelf.reading('https://a.example.com/p/6');
    expect(lastPayload().readingN).toBe(6);
    expect(shelf.items().find((s) => s.n === 6)?.origin).toBe('read');
    shelf.read('https://a.example.com/p/6', '真正的标题', true);
    expect(lastPayload().readingN).toBeUndefined();
    expect(shelf.items().find((s) => s.n === 6)?.title).toBe('真正的标题');
  });

  it('读一个架上没有也没搜过的网址 ⇒ 补下一号上架；⑨ 读失败清在读标并**撤掉占位**（别装读过）', () => {
    const shelf = createSourceShelf('s3');
    shelf.found('q', results(2));
    shelf.reading('https://new.example.com/x');
    expect(shelf.items().map((s) => s.n)).toEqual([1, 2, 3]);
    shelf.read('https://new.example.com/x', undefined, false);
    expect(lastPayload().readingN).toBeUndefined();
    expect(shelf.items().map((s) => s.n)).toEqual([1, 2]);
    expect(lastPayload().items.map((s) => s.n)).toEqual([1, 2]);
    // 号不回收：它稍后被读成功仍是 3 号
    shelf.reading('https://new.example.com/x');
    shelf.read('https://new.example.com/x', '读到了', true);
    expect(shelf.items().find((s) => s.n === 3)).toMatchObject({ origin: 'read', title: '读到了' });
  });

  it('⑨ 搜到的条目读失败 ⇒ 退回 search 档（摘要还在，收口时再定去留）', () => {
    const shelf = createSourceShelf('s3b');
    shelf.found('q', results(2));
    shelf.reading('https://a.example.com/p/2');
    expect(shelf.items().find((s) => s.n === 2)?.origin).toBe('read');
    shelf.read('https://a.example.com/p/2', undefined, false);
    expect(shelf.items().find((s) => s.n === 2)).toMatchObject({ origin: 'search', query: 'q' });
  });

  it('⑦ 非 http(s) 不占号（返回 0）不上架', () => {
    const shelf = createSourceShelf('s4');
    const bad: SearchResult = { title: 'x', url: 'javascript:alert(1)', snippet: '', source: 'bing' };
    expect(shelf.found('q', [bad, ...results(1)])).toEqual([0, 1]);
    expect(shelf.items()).toHaveLength(1);
    shelf.reading('file:///etc/passwd');
    expect(shelf.items()).toHaveLength(1);
  });

  it('④ 架满（12）后新的 read 挤掉编号最大的 search 条；read/pick 不被挤', () => {
    const shelf = createSourceShelf('s5');
    shelf.found('q1', results(5, 'a'));
    shelf.found('q2', results(5, 'b'));
    shelf.found('q3', results(5, 'c')); // 只有前 2 条能上（架 12）
    expect(shelf.items()).toHaveLength(12);
    shelf.reading('https://z.example.com/read');
    expect(shelf.items()).toHaveLength(12);
    const ns = shelf.items().map((s) => s.n);
    expect(ns).not.toContain(12); // 挤掉的是编号最大的 search
    expect(ns).toContain(16);
  });
});

describe('shelf：精选与发布', () => {
  it('⑤ pick 只认 known 网址、最多 3 条、未知退回；精选后 origin=pick 带 why', () => {
    const shelf = createSourceShelf('s6');
    shelf.found('q', results(7));
    const out = shelf.pick([
      { url: 'https://a.example.com/p/2', why: '官方文档' },
      { url: 'https://a.example.com/p/7', why: '没上架但搜到过' },
      { url: 'https://nope.example.com/', why: '编的' },
      { url: 'https://a.example.com/p/3', why: '第四条' },
    ]);
    expect(out.picked.map((s) => s.n)).toEqual([2, 7]);
    expect(out.unknown).toEqual(['https://nope.example.com/']);
    expect(shelf.items().find((s) => s.n === 2)).toMatchObject({ origin: 'pick', why: '官方文档' });
    expect(shelf.items().find((s) => s.n === 7)?.origin).toBe('pick');
  });

  it('⑥ 每次变化整表下发 block 帧：blockId=sources:<sid>，payload.kind=sources；无变化不发', () => {
    const shelf = createSourceShelf('s7');
    shelf.found('q', []);
    expect(published).toHaveLength(0);
    shelf.found('q', results(2));
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'block', blockId: 'sources:s7' });
    expect(lastPayload()).toMatchObject({ kind: 'sources', sessionId: 's7' });
    expect(lastPayload().items).toHaveLength(2);
    shelf.pick([{ url: 'https://nowhere.example.com', why: 'x' }]);
    expect(published).toHaveLength(1);
  });

  it('⑧ 在线注册表：knows 含未上架但占过号的；dispose 后查不到；normalize 去 hash', () => {
    const shelf = createSourceShelf('s8');
    shelf.found('q', results(7));
    expect(liveShelfKnows('s8', 'https://a.example.com/p/7#frag')).toBe(true);
    expect(liveShelfKnows('s8', 'https://a.example.com/p/99')).toBe(false);
    expect(liveShelfKnows('s-none', 'https://a.example.com/p/1')).toBe(false);
    expect(normalizeSourceUrl('https://Example.com/#top')).toBe('https://example.com');
    shelf.dispose();
    expect(liveShelfKnows('s8', 'https://a.example.com/p/1')).toBe(false);
  });
});

describe('shelf：收口 settle（2026-09-30）', () => {
  it('⑩ 只留读成功 / 精选 / 正文 [n] 引用到的；编号不动；整表再发一帧', () => {
    const shelf = createSourceShelf('s-settle');
    shelf.found('q', results(6)); // 1–5 上架，6 只占号
    shelf.reading('https://a.example.com/p/2');
    shelf.read('https://a.example.com/p/2', '读过的', true);
    shelf.pick([{ url: 'https://a.example.com/p/4', why: '官方' }]);
    published.length = 0;
    const kept = shelf.settle('先看 [2]，再看[5]；a[1] 是下标不算，[3](https://x) 是链接也不算。');
    expect(kept.map((s) => `${s.n}:${s.origin}`)).toEqual(['2:read', '4:pick', '5:search']);
    expect(shelf.items().map((s) => s.n)).toEqual([2, 4, 5]);
    expect(published).toHaveLength(1);
    expect(lastPayload().items.map((s) => s.n)).toEqual([2, 4, 5]);
    expect(lastPayload().readingN).toBeUndefined();
  });

  it('⑩ 没什么可撤（全是读过/精选）⇒ 不多发帧；读到一半被打断的占位也撤', () => {
    const shelf = createSourceShelf('s-settle-2');
    shelf.reading('https://r.example.com/a');
    shelf.read('https://r.example.com/a', 'A', true);
    published.length = 0;
    expect(shelf.settle('没有引用').map((s) => s.n)).toEqual([1]);
    expect(published).toHaveLength(0);
    shelf.reading('https://r.example.com/b'); // 读到一半（中止）
    expect(shelf.settle('').map((s) => s.n)).toEqual([1]);
    expect(lastPayload().readingN).toBeUndefined();
  });
});
