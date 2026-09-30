/**
 * sources 契约单测（docs/SOURCE-TRACE-SPEC.md §3）：
 * 类型判定 / 视频嵌入地址 / 排序 / 引用查找 / 可上架判定——全是纯函数，锁口径。
 */
import { describe, it, expect } from 'vitest';
import { citedSourceNumbers, detectSourceKind, isShelvableUrl, orderSources, siteOf, sourceByN, videoEmbedUrl, type SourceItem } from './sources.js';

const item = (n: number, origin: SourceItem['origin']): SourceItem => ({
  n,
  url: `https://example.com/${n}`,
  title: `t${n}`,
  site: 'example.com',
  kind: 'page',
  origin,
});

describe('sources：类型与嵌入', () => {
  it('★ 视频站只认 YouTube / B 站，且都换成官方播放器地址；其余为 null', () => {
    expect(videoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3s')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(videoEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(videoEmbedUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=1')).toBe(
      'https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7&autoplay=0&high_quality=1',
    );
    expect(videoEmbedUrl('https://www.youtube.com/watch?v=<script>')).toBeNull();
    expect(videoEmbedUrl('https://vimeo.com/123')).toBeNull();
    expect(videoEmbedUrl('not a url')).toBeNull();
  });

  it('detectSourceKind：视频 / pdf / 图片 / 网页；坏 URL 归网页', () => {
    expect(detectSourceKind('https://youtu.be/dQw4w9WgXcQ')).toBe('video');
    expect(detectSourceKind('https://arxiv.org/pdf/1706.03762.PDF')).toBe('pdf');
    expect(detectSourceKind('https://upload.wikimedia.org/a/b/Cell.png')).toBe('image');
    expect(detectSourceKind('https://zh.wikipedia.org/wiki/闭包')).toBe('page');
    expect(detectSourceKind('::')).toBe('page');
  });

  it('siteOf 去 www.；isShelvableUrl 只放 http(s)', () => {
    expect(siteOf('https://www.zhihu.com/question/1')).toBe('zhihu.com');
    expect(siteOf('nope')).toBe('nope');
    expect(isShelvableUrl('https://a.b/c')).toBe(true);
    expect(isShelvableUrl('javascript:alert(1)')).toBe(false);
    expect(isShelvableUrl('data:text/html,hi')).toBe(false);
  });
});

describe('sources：排序与引用', () => {
  it('orderSources：精选 → 读过 → 搜到，同档按编号；不改入参', () => {
    const items = [item(3, 'search'), item(1, 'search'), item(5, 'pick'), item(2, 'read'), item(4, 'read')];
    const snap = JSON.stringify(items);
    expect(orderSources(items).map((s: SourceItem) => s.n)).toEqual([5, 2, 4, 1, 3]);
    expect(JSON.stringify(items)).toBe(snap);
  });

  it('sourceByN：按编号找；没有 ⇒ undefined（正文 [n] 没对应就保持纯文本）', () => {
    const items = [item(1, 'search'), item(7, 'pick')];
    expect(sourceByN(items, 7)?.origin).toBe('pick');
    expect(sourceByN(items, 2)).toBeUndefined();
  });
});

describe('citedSourceNumbers（与前端 CITE 同口径）', () => {
  it('认 [n] / [1, 4] / [2][5] 与行首 [3]；不认下标 a[1]、链接 [3](url)、三位数与 0', () => {
    const got = citedSourceNumbers('据[2]所述，[1, 4]与[6][7]；a[9] 不算，[3](https://x) 不算，[123] 不算，[0] 不算。\n[8] 行首算');
    expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 4, 6, 7, 8]);
    expect(citedSourceNumbers('没有引用').size).toBe(0);
  });
});
