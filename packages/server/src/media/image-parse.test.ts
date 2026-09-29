/** media/image-sources + image-verify 的纯解析（2026-09-29）：上游格式漂移时在这里先红，而不是线上静默 0 图。 */
import { describe, it, expect } from 'vitest';
import { parseCommons, parseBingImages } from './image-sources.js';
import { parseImageVerdict, leaksAnswer } from './image-verify.js';

describe('parseCommons', () => {
  it('取缩略图、页面、许可与作者（去 HTML）', () => {
    const json = { query: { pages: { 1: { index: 1, title: 'File:Cat.jpg', imageinfo: [{ thumburl: 'https://u/t.jpg', url: 'https://u/o.jpg', descriptionurl: 'https://c/File:Cat.jpg', mime: 'image/jpeg', extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a href="x">Bob</a>' } } }] } } } };
    const [c] = parseCommons(json);
    expect(c).toMatchObject({ url: 'https://u/t.jpg', pageUrl: 'https://c/File:Cat.jpg', source: 'commons', license: 'CC BY-SA 4.0' });
    expect(c!.author).toBe('Bob');
  });
  it('坏输入给空数组', () => {
    expect(parseCommons(null)).toEqual([]);
    expect(parseCommons({})).toEqual([]);
  });
});

describe('parseBingImages', () => {
  it('从 m 属性里取 murl/purl', () => {
    const m = JSON.stringify({ murl: 'https://img.test/a.jpg', purl: 'https://page.test/a', t: 'A' }).replace(/"/g, '&quot;');
    const out = parseBingImages(`<a class="iusc" m="${m}"></a>`);
    expect(out[0]).toMatchObject({ url: 'https://img.test/a.jpg', pageUrl: 'https://page.test/a', source: 'bing', license: null });
  });
  it('没结果给空数组', () => expect(parseBingImages('<html></html>')).toEqual([]));
});

describe('parseImageVerdict / leaksAnswer', () => {
  it('解析 JSON（允许外面包围栏）', () => {
    const v = parseImageVerdict('```json\n{"match":"yes","depicts":"猫","text_in_image":"","reveals_answer":false}\n```');
    expect(v).toMatchObject({ match: 'yes', depicts: '猫', revealsAnswer: false });
  });
  it('match 非法 → null', () => expect(parseImageVerdict('{"match":"maybe","depicts":"x"}')).toBeNull());
  it('图中文字含答案 → 泄露；1 个字的答案不算（太容易误伤）', () => {
    const v = { match: 'yes' as const, depicts: '', textInImage: 'Mitochondrion 线粒体', revealsAnswer: false };
    expect(leaksAnswer(v, ['线粒体'])).toBe(true);
    expect(leaksAnswer(v, ['叶'])).toBe(false);
    expect(leaksAnswer({ ...v, textInImage: '', revealsAnswer: true }, [])).toBe(true);
  });
});
