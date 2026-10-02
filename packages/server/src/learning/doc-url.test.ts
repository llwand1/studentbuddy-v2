/**
 * learning/doc-url —— 网页资料（契约 `docs/DOC-RAG-SPEC.md` §10）回归。
 * 全程 mock DNS/fetch，不碰真实网络（真机连通性由人工验证补位，同 fetch-page.test.ts 的手法）。
 *
 * 本文件锁五类事，都是「写错了不会报错、只会悄悄变坏」的：
 * ① **溯源抬头**：模型必须知道这是一张网页快照、来自哪、哪天抓的——
 *    没有它，模型会把「快照里没写」说成「现实中不存在」，这是 DOC-RAG §3.5 同一条老病；
 * ② **三道内容闸确实接上了**（不是只接了 htmlToText）：PDF/二进制拒收、GBK 不以乱码入库；
 * ③ **失败分类与状态码**：415（不是网页）/ 422（抓不到正文）/ 502（没取回来）各自分明——
 *    合并成一个 500 的话，学习者就不知道该改网址还是该改用粘贴；
 * ④ **SSRF 原因不外泄**：接口响应与模型上下文一样是探测面，内网地址与端口都不许出现；
 * ⑤ **截断如实**（ADR-5）：截了要说截了，且 `sourceChars` 报的是**截断前**的数。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOC_URL_MAX_CHARS } from '@sb/shared';

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const { fetchDocFromUrl } = await import('./doc-url.js');

type Fake = { text?: string; status?: number; contentType?: string; bytes?: Uint8Array };
const calls: string[] = [];

function mockFetch(handler: (url: string) => Fake) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const r = handler(url);
      const status = r.status ?? 200;
      return {
        ok: status < 400,
        status,
        headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? (r.contentType ?? null) : null) },
        text: async () => r.text ?? '',
        arrayBuffer: async () => {
          const b = r.bytes ?? new TextEncoder().encode(r.text ?? '');
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        },
      } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('doc-url — 网址校验（出门之前就能判的，不许先跑一趟网络）', () => {
  it('空网址 / 纯空白 → 400，且一次请求都不发', async () => {
    mockFetch(() => ({ text: '<p>x</p>' }));
    for (const bad of ['', '   ', '\n']) {
      const r = await fetchDocFromUrl(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('非 http(s)（file:// / javascript: / 裸域名）→ 400，且一次请求都不发', async () => {
    mockFetch(() => ({ text: '<p>x</p>' }));
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'example.com/a']) {
      const r = await fetchDocFromUrl(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) {
        expect(r.status, bad).toBe(400);
        expect(r.error, bad).toContain('http');
      }
    }
    expect(calls).toHaveLength(0);
  });
});

describe('doc-url — 成功路径与溯源抬头', () => {
  it('HTML → 资料名取 <title>，正文含抬头四要素 + 网页正文，script 不入库', async () => {
    mockFetch(() => ({
      text:
        '<html><head><title>牛顿第二定律 - 示例百科</title><script>evil()</script></head>' +
        '<body><h1>牛顿第二定律</h1><p>F 等于 ma。</p></body></html>',
    }));
    const r = await fetchDocFromUrl('https://baike.example.org/newton');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { draft } = r;

    expect(draft.name).toBe('牛顿第二定律 - 示例百科');
    expect(draft.site).toBe('baike.example.org');
    expect(draft.url).toBe('https://baike.example.org/newton');
    // ★ 抬头四要素：缺任何一条，模型都可能把「快照里没写」说成「不存在」
    expect(draft.text).toContain('【资料来源：网页快照】');
    expect(draft.text).toContain('网址：https://baike.example.org/newton');
    expect(draft.text).toContain('标题：牛顿第二定律 - 示例百科');
    expect(draft.text).toContain('站点：baike.example.org');
    expect(draft.text).toMatch(/抓取日期：\d{4}-\d{2}-\d{2}/);
    expect(draft.text).toContain('不等于该网页或现实中不存在');
    // 正文真的在里面，脚本真的不在
    expect(draft.text).toContain('F 等于 ma');
    expect(draft.text).not.toContain('evil()');
    expect(draft.clipped).toBe(false);
  });

  it('页面没给 <title> → 资料名退回站名（pill 上不能是空白）', async () => {
    mockFetch(() => ({ text: '<body><p>一些正文内容</p></body>' }));
    const r = await fetchDocFromUrl('https://www.notitle.example/a/b');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.name).toBe('notitle.example'); // siteOf 去掉 www.
    expect(r.draft.text).toContain('标题：（该页未给标题）');
  });

  it('★ 超上限 → 截断并如实标注，且 sourceChars 报的是**截断前**的数', async () => {
    const long = '甲'.repeat(DOC_URL_MAX_CHARS + 500);
    mockFetch(() => ({ text: `<p>${long}</p>` }));
    const r = await fetchDocFromUrl('https://long.example/x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.draft.clipped).toBe(true);
    expect(r.draft.sourceChars).toBe(DOC_URL_MAX_CHARS + 500); // 不是截断后的数
    expect(r.draft.text).toContain('已截取前');
    expect(r.draft.text).toContain('后面的内容不在这份资料里');
    // 抬头 + 截断说明之外，正文部分确实只留了上限那么多
    expect(r.draft.text.split('甲').length - 1).toBe(DOC_URL_MAX_CHARS);
  });
});

describe('doc-url — 内容闸确实接上了（不是只接了 htmlToText）', () => {
  it('content-type: application/pdf → 415，且二进制字节一个都不入库', async () => {
    mockFetch(() => ({ contentType: 'application/pdf', text: '%PDF-1.4\n1 0 obj\nstream\n' }));
    const r = await fetchDocFromUrl('https://ex.example/paper.pdf');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(415);
    expect(r.error).toContain('不是网页');
    expect(r.error).toContain('application/pdf'); // 告诉他「它是什么」，好改道
    expect(r.error).not.toContain('%PDF-');
  });

  it('★ 谎报 text/html 实为真 PNG 字节 → 仍 415（字节层魔数兜底）', async () => {
    const PNG = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    mockFetch(() => ({ contentType: 'text/html', bytes: PNG }));
    const r = await fetchDocFromUrl('https://ex.example/lie.png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(415);
    expect(r.error).toContain('疑似二进制');
  });

  it('★ GBK 页按声明解码入库，正文零替换符（编码层不能漏接）', async () => {
    // 「中文测试」的 GBK 字节；若有人把 decodeText 拿掉改回 res.text()，这条当场红
    const GBK = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
    mockFetch(() => ({ contentType: 'text/html; charset=GBK', bytes: GBK }));
    const r = await fetchDocFromUrl('https://gbk.example/x');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.text).toContain('中文测试');
    expect(r.draft.text).not.toContain('\uFFFD');
  });
});

describe('doc-url — 失败分类与安全口径', () => {
  it('纯脚本渲染页（无正文）→ 422，并指一条真的出路（改用粘贴）', async () => {
    mockFetch(() => ({ text: '<html><script>document.write("x")</script></html>' }));
    const r = await fetchDocFromUrl('https://spa.example/x');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
    expect(r.error).toContain('没抓到正文');
    expect(r.error).toContain('粘贴'); // 不给死胡同：这类页换个网址也没用，得换办法
  });

  it('对方 404 → 502，如实带上状态码（真因由知道的一方给出）', async () => {
    mockFetch(() => ({ status: 404 }));
    const r = await fetchDocFromUrl('https://ex.example/gone');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(502);
    expect(r.error).toContain('HTTP 404');
  });

  it('★ 内网地址被 SSRF 拦下：响应里不含该地址与端口，且请求根本没发出去', async () => {
    mockFetch(() => ({ text: '<p>不该被读到</p>' }));
    const r = await fetchDocFromUrl('http://127.0.0.1:8080/admin');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // ★ 核心锁：把「解析到内网/回环」原样回出去 = 把本机网络拓扑做成探测面
    expect(r.error).not.toContain('127.0.0.1');
    expect(r.error).not.toContain('8080');
    expect(r.error).toContain('该地址不被允许访问');
    expect(calls).toHaveLength(0); // assertSafeUrl 在 fetch 之前就拦下了
  });
});
