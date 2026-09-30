/**
 * video-route 契约单测（docs/SOURCE-TRACE-SPEC.md §12）：
 * 查询词清洗与推导 / B站·抖音网址识别 / 搜索高亮剥离 / 播放量格式 / 站内搜索页——全是纯函数，锁口径。
 */
import { describe, it, expect } from 'vitest';
import {
  VIDEO_QUERY_MAX,
  VIDEO_ROUTE_META,
  bvidFromUrl,
  cleanVideoQuery,
  douyinVideoIdFromUrl,
  formatPlays,
  stripSearchEm,
  videoQueryFromText,
  videoSiteSearchUrl,
} from './video-route.js';

describe('video-route：查询词', () => {
  it('cleanVideoQuery：并空白、去控制字符、截到 80；空串表示没法搜', () => {
    expect(cleanVideoQuery('  牛顿\t第二\n定律  ')).toBe('牛顿 第二 定律');
    expect(cleanVideoQuery('a\u0000b')).toBe('a b');
    expect(cleanVideoQuery('x'.repeat(200))).toHaveLength(VIDEO_QUERY_MAX);
    expect(cleanVideoQuery('   ')).toBe('');
  });

  it('videoQueryFromText：优先标题、剥 Markdown 与 [n] 引用、句读处截断、≤30 字；推不出给空', () => {
    expect(videoQueryFromText('先看结论。\n\n## 牛顿第二定律 [1]\n\n公式 **F = ma** …')).toBe('牛顿第二定律');
    expect(videoQueryFromText('**光合作用**是植物把光能转成化学能的过程[2][3]，分两个阶段。')).toBe('光合作用是植物把光能转成化学能的过程');
    expect(videoQueryFromText('- 第一点\n- 第二点\n勾股定理：直角三角形两直角边平方和等于斜边平方')).toBe('勾股定理');
    expect(videoQueryFromText('见 [维基百科](https://x.example.com)：欧拉公式')).toBe('见 维基百科');
    expect(videoQueryFromText('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多出来的').length).toBeLessThanOrEqual(30);
    expect(videoQueryFromText('好')).toBe('');
    expect(videoQueryFromText('')).toBe('');
  });

  it('videoSiteSearchUrl：B站全站搜、抖音视频页签，查询词都编码', () => {
    expect(videoSiteSearchUrl('bilibili', '牛顿 定律')).toBe('https://search.bilibili.com/all?keyword=%E7%89%9B%E9%A1%BF%20%E5%AE%9A%E5%BE%8B');
    expect(videoSiteSearchUrl('douyin', 'a&b')).toBe('https://www.douyin.com/search/a%26b?type=video');
    expect(VIDEO_ROUTE_META.bilibili.playable).toBe(true);
    expect(VIDEO_ROUTE_META.douyin.playable).toBe(false);
  });
});

describe('video-route：网址识别与格式', () => {
  it('bvidFromUrl：www / m / b23 的 /video/BV… 认，其余 null', () => {
    expect(bvidFromUrl('https://www.bilibili.com/video/BV1nR4y1y75t/?spm_id_from=333')).toBe('BV1nR4y1y75t');
    expect(bvidFromUrl('https://m.bilibili.com/video/BV1nR4y1y75t')).toBe('BV1nR4y1y75t');
    expect(bvidFromUrl('https://b23.tv/video/BV1nR4y1y75t')).toBe('BV1nR4y1y75t');
    expect(bvidFromUrl('https://www.bilibili.com/video/av348162724')).toBeNull();
    expect(bvidFromUrl('https://space.bilibili.com/439177375')).toBeNull();
    expect(bvidFromUrl('https://evil.example.com/video/BV1nR4y1y75t')).toBeNull();
    expect(bvidFromUrl('nope')).toBeNull();
  });

  it('douyinVideoIdFromUrl：只认视频页与 v.douyin 短链；主页 / 搜索页 / 话题页 / 别的站 ⇒ null', () => {
    expect(douyinVideoIdFromUrl('https://www.douyin.com/video/7311234567890123456')).toBe('7311234567890123456');
    expect(douyinVideoIdFromUrl('https://v.douyin.com/iRNBho6u/')).toBe('iRNBho6u');
    expect(douyinVideoIdFromUrl('https://www.douyin.com/user/MS4wLjABAAAA')).toBeNull();
    expect(douyinVideoIdFromUrl('https://www.douyin.com/search/%E7%89%9B%E9%A1%BF')).toBeNull();
    expect(douyinVideoIdFromUrl('https://www.douyin.com/video/abc')).toBeNull();
    expect(douyinVideoIdFromUrl('https://notdouyin.com/video/7311234567890123456')).toBeNull();
    expect(douyinVideoIdFromUrl('::')).toBeNull();
  });

  it('stripSearchEm：剥 <em class="keyword">、还原实体、并空白', () => {
    expect(stripSearchEm('【高中物理】59.<em class="keyword">牛顿第二定律</em>|最通透 &amp; 最详细')).toBe('【高中物理】59.牛顿第二定律|最通透 & 最详细');
    expect(stripSearchEm('a &lt;b&gt;  &quot;c&quot; &#39;d&#39;')).toBe('a <b> "c" \'d\'');
  });

  it('formatPlays：万以下原数、万级一位小数、十万起整数万、亿级一位小数；坏值空串', () => {
    expect(formatPlays(9_999)).toBe('9999');
    expect(formatPlays(67_566)).toBe('6.8万');
    expect(formatPlays(30_000)).toBe('3万');
    expect(formatPlays(675_661)).toBe('68万');
    expect(formatPlays(123_456_789)).toBe('1.2亿');
    expect(formatPlays(-1)).toBe('');
    expect(formatPlays(Number.NaN)).toBe('');
  });
});
