/**
 * sources/reader 单测（契约 docs/SOURCE-TRACE-SPEC.md §5）。
 *
 * 清洗层是安全边界，逐条钉：① script/style/iframe/form 连内容删；② 非白名单标签剥壳留字；
 * ③ 属性只留受控几项（onclick 之类事件属性、style、class 全丢）；④ 链接只放 http(s)、相对地址按页面补全、外链带 rel；
 * ⑤ 图片 javascript:/data: 丢、懒加载 data-src 兜底；⑥ 散 `<` 转义；⑦ 标题优先 og:title、正文区优先 <article>；
 * ⑧ 正文太短外壳给提示；⑨ primed HTML 直接出页不发请求，缓存命中不重取；⑩ 图片类资料不取页。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchSafe = vi.fn();
vi.mock('../search/ssrf-guard.js', () => ({ fetchSafe: (...a: unknown[]) => fetchSafe(...a) }));

const { sanitizeReaderHtml, extractReader, renderReaderDoc, loadReaderDoc, primeReaderHtml, resetReaderCache, absoluteHttpUrl } =
  await import('./reader.js');

const BASE = 'https://site.example.com/docs/page.html';

beforeEach(() => {
  resetReaderCache();
  fetchSafe.mockReset();
});

describe('sanitizeReaderHtml：白名单清洗', () => {
  it('① 危险块连内容一起删；② 非白名单标签剥壳留字；③ 属性全丢', () => {
    const html =
      '<div class="x" onclick="evil()"><script>alert(1)</script><style>p{}</style><p style="color:red">正文<font>字</font></p>' +
      '<iframe src="https://evil"></iframe><form><input value="x"><button>提交</button></form><custom-el>自定义</custom-el></div>';
    const out = sanitizeReaderHtml(html, BASE);
    expect(out).toBe('<div><p>正文字</p>自定义</div>');
  });

  it('④ 链接：http(s) 放行并补全 + 带 rel；javascript: 降级为无 href 的 <a>', () => {
    const out = sanitizeReaderHtml('<a href="/rel?x=1#f">相对</a><a href="javascript:alert(1)">坏</a><a href="mailto:a@b">邮</a>', BASE);
    expect(out).toBe(
      '<a href="https://site.example.com/rel?x=1#f" target="_blank" rel="noopener noreferrer nofollow">相对</a><a>坏</a><a>邮</a>',
    );
  });

  it('⑤ 图片：data:/javascript: 整个丢；data-src 懒加载兜底；alt 保留并转义', () => {
    const out = sanitizeReaderHtml(
      '<img src="data:image/svg+xml,<svg onload=alert(1)>"><img data-src="//cdn.example.com/a.png" alt="a&quot;b"><img src="../i.jpg">',
      BASE,
    );
    expect(out).toBe(
      '<img src="https://cdn.example.com/a.png" alt="a&quot;b" loading="lazy" referrerpolicy="no-referrer">' +
        '<img src="https://site.example.com/i.jpg" alt="" loading="lazy" referrerpolicy="no-referrer">',
    );
  });

  it('⑥ 散 `<` 转义、注释与 doctype 丢；td colspan 只认 1–2 位数字', () => {
    expect(sanitizeReaderHtml('a < b <!-- c --> <!doctype html> d', BASE)).toBe('a &lt; b   d');
    expect(sanitizeReaderHtml('<td colspan="2" rowspan="x">1</td>', BASE)).toBe('<td colspan="2">1</td>');
  });

  it('absoluteHttpUrl：协议白名单 + 相对补全', () => {
    expect(absoluteHttpUrl('ftp://x/y', BASE)).toBeNull();
    expect(absoluteHttpUrl(null, BASE)).toBeNull();
    expect(absoluteHttpUrl('img.png', BASE)).toBe('https://site.example.com/docs/img.png');
  });
});

describe('extractReader / renderReaderDoc', () => {
  const PAGE =
    '<html><head><title>页面标题 - 站点</title><meta property="og:title" content="OG 标题"><meta property="og:image" content="/lead.jpg">' +
    '<meta name="author" content="小明"></head><body><nav>导航</nav><article><h1>正文标题</h1>' +
    `<p>${'内容'.repeat(300)}</p><img src="pic.png"></article><footer>页脚</footer></body></html>`;

  it('⑦ 标题优先 og:title；正文区优先 <article>（nav/footer 不进来）；署名与首图进外壳', () => {
    const doc = extractReader(PAGE, BASE);
    expect(doc.title).toBe('OG 标题');
    expect(doc.body).toContain('<h1>正文标题</h1>');
    expect(doc.body).not.toContain('导航');
    expect(doc.body).not.toContain('页脚');
    expect(doc.byline).toBe('小明');
    expect(doc.lead).toBe('https://site.example.com/lead.jpg');
    expect(doc.site).toBe('site.example.com');
    const html = renderReaderDoc(doc, BASE);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain('原网页 ↗');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('class="src-note"');
  });

  it('⑧ 正文太短（脚本渲染页）外壳给「看原网页」提示；<article> 太短时退到 <body>', () => {
    const doc = extractReader('<html><head><title>T</title></head><body><article><p>短</p></article><p>外面的字</p></body></html>', BASE);
    expect(doc.body).toContain('外面的字');
    expect(renderReaderDoc(doc, BASE)).toContain('class="src-note"');
  });
});

describe('loadReaderDoc：缓存与取页', () => {
  it('⑨ primed HTML 直接出页、不发请求；第二次命中缓存', async () => {
    primeReaderHtml('https://p.example.com/x', '<html><head><title>已读页</title></head><body><p>hello</p></body></html>');
    const r = await loadReaderDoc('https://p.example.com/x', '');
    expect(r.ok && r.html).toContain('已读页');
    expect(fetchSafe).not.toHaveBeenCalled();
    resetReaderCache();
    fetchSafe.mockResolvedValue(new Response('<html><title>网取</title><body><p>x</p></body></html>', { headers: { 'content-type': 'text/html' } }));
    const a = await loadReaderDoc('https://n.example.com/y', '');
    const b = await loadReaderDoc('https://n.example.com/y', '');
    expect(a.ok && a.html).toContain('网取');
    expect(b.ok).toBe(true);
    expect(fetchSafe).toHaveBeenCalledTimes(1);
  });

  it('⑩ 图片类资料不取页：直接一张原图 + 标题', async () => {
    const r = await loadReaderDoc('https://img.example.com/cell.png', '细胞');
    expect(r.ok && r.html).toContain('<img src="https://img.example.com/cell.png"');
    expect(fetchSafe).not.toHaveBeenCalled();
  });

  it('非网页内容类型 415；PDF 类型出提示页；HTTP 错误 502；超时给「读取超时」', async () => {
    fetchSafe.mockResolvedValueOnce(new Response('x', { headers: { 'content-type': 'image/png' } }));
    expect(await loadReaderDoc('https://a.example.com/1', '')).toMatchObject({ ok: false, status: 415 });
    fetchSafe.mockResolvedValueOnce(new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } }));
    const pdf = await loadReaderDoc('https://a.example.com/2', '论文');
    expect(pdf.ok && pdf.html).toContain('这是一份 PDF');
    fetchSafe.mockResolvedValueOnce(new Response('nope', { status: 503 }));
    expect(await loadReaderDoc('https://a.example.com/3', '')).toMatchObject({ ok: false, status: 502, reason: '对方返回 HTTP 503' });
    fetchSafe.mockRejectedValueOnce(new DOMException('The operation was aborted', 'AbortError'));
    expect(await loadReaderDoc('https://a.example.com/4', '')).toMatchObject({ ok: false, reason: '读取超时' });
  });
});
