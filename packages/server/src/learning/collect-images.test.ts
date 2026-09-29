/** learning/collect-images — 题源配图搬运的单测（契约 docs/QUIZ-TIER-SPEC.md §5）。下载打桩，不碰网。 */
import { describe, it, expect } from 'vitest';
import type { QuizQuestion } from '@sb/shared';
import { attachSourceImages, buildImagesBlock, extractPageImages, resolveImageRef } from './collect-images.js';

const HTML = `
<html><body>
<img src="/static/logo.png" alt="站点 logo">
<img src="https://cdn.example.com/icon.svg" width="16" height="16">
<img data-src="/upload/2023/fig-circuit.png" alt="电路图" src="data:image/gif;base64,R0lGOD">
<img src="https://img.example.com/q2.jpg" alt="函数图像">
<img src="https://img.example.com/q2.jpg" alt="重复">
<img src="https://img.example.com/qrcode_share.png" alt="扫码">
</body></html>`;

describe('extractPageImages', () => {
  it('取 data-src 优先、相对路径补全、去 logo/图标/二维码/重复/data:', () => {
    const imgs = extractPageImages(HTML, 'https://www.example.com/paper/1.html');
    expect(imgs.map((i) => i.url)).toEqual([
      'https://www.example.com/upload/2023/fig-circuit.png',
      'https://img.example.com/q2.jpg',
    ]);
    expect(imgs[0]).toMatchObject({ n: 1, alt: '电路图' });
  });
  it('没图 → 空数组，清单段为空串', () => {
    expect(extractPageImages('<p>无图</p>', 'https://a.test')).toEqual([]);
    expect(buildImagesBlock([])).toBe('');
  });
});

describe('resolveImageRef（只认编号，不认网址）', () => {
  const imgs = extractPageImages(HTML, 'https://www.example.com/');
  it('合法编号 → 清单项', () => {
    expect(resolveImageRef(2, imgs)?.url).toBe('https://img.example.com/q2.jpg');
    expect(resolveImageRef('1', imgs)?.alt).toBe('电路图');
  });
  it('0 / 越界 / 非整数 / 网址 → null', () => {
    expect(resolveImageRef(0, imgs)).toBeNull();
    expect(resolveImageRef(9, imgs)).toBeNull();
    expect(resolveImageRef(1.5, imgs)).toBeNull();
    expect(resolveImageRef('https://evil.test/x.png', imgs)).toBeNull();
  });
});

describe('attachSourceImages（失败只是没图）', () => {
  const mk = (): QuizQuestion => ({ type: 'single', question: 'q', options: ['A', 'B'], answer: [0] });
  it('下载成功 → 挂 photo（站内地址 + 题源署名 + 原页链接）；失败 → 记原因、题不动', async () => {
    const ok = mk();
    const bad = mk();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const download = (async (url: string) =>
      url.includes('good') ? { ok: true as const, bytes, ext: 'png', mime: 'image/png' } : { ok: false as const, kind: 'not_image' as const, contentType: 'text/html' }) as never;
    const r = await attachSourceImages(
      [
        { question: ok, image: { n: 1, url: 'https://img.test/good.png', alt: '电路图' }, pageTitle: '2023 高考物理', pageUrl: 'https://p.test/1' },
        { question: bad, image: { n: 2, url: 'https://img.test/bad.png', alt: '' }, pageTitle: '2023 高考物理', pageUrl: 'https://p.test/1' },
      ],
      { download },
    );
    expect(r.attached).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(ok.photo?.src).toMatch(/^\/api\/images\//);
    expect(ok.photo?.credit).toContain('题源页配图 · 2023 高考物理');
    expect(ok.photo?.pageUrl).toBe('https://p.test/1');
    expect(bad.photo).toBeUndefined();
  });
});
