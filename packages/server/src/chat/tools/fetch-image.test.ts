/**
 * chat/tools/fetch-image —— `fetch_image` 回归（2026-09-20 新建）。
 * 全程 mock DNS/fetch，**绝不碰真实网络**；落盘走 `SB_DATA_DIR` 临时目录，**不碰真库真缓存**。
 *
 * 本文件锁五类「写错不会报错」的事：
 * ① **元数据**（kind 决定免确认与超时档；idempotent 决定能不能重试 —— 声明错没有任何报错）；
 * ② **回灌的用法**（只回「取到了」而不教模型怎么写进正文，学习者看到的是一串字符而不是图
 *    —— 功能等于没做，§N15 的同款形态）；
 * ③ **判在字节上**（服务端把图片声明成 `octet-stream` 是图床的常见形态，看声明就会漏搬）；
 * ④ **拒绝路径一律零落盘**（拒了却把文件留下 = 磁盘上攒一堆看不见的垃圾，没人会发现）；
 * ⑤ **安全**（SSRF 拦截文案不许把内网地址回灌给模型 —— 那是本机的探测面）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fetchimage-test-'));

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const { runTool, toolMeta } = await import('./index.js');
const { imagesDir, MAX_IMAGE_BYTES } = await import('../../storage/image-cache.js');
import type { ToolContext } from './registry.js';

/** 真实 PNG 头（8 字节签名 + IHDR 起头），够嗅探用。 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

type Fake = {
  bytes?: Uint8Array;
  text?: string;
  status?: number;
  contentType?: string;
  /** `null` = 服务端不给 content-length（测缺失/谎报路径）；缺省按字节数如实给 */
  contentLength?: string | null;
};
const calls: string[] = [];

function mockFetch(handler: (url: string) => Fake) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const r = handler(url);
      const status = r.status ?? 200;
      const bytes = r.bytes ?? new TextEncoder().encode(r.text ?? '');
      const len = r.contentLength === undefined ? String(bytes.byteLength) : r.contentLength;
      return {
        ok: status < 400,
        status,
        headers: {
          get: (k: string) => {
            const key = k.toLowerCase();
            if (key === 'content-type') return r.contentType ?? null;
            if (key === 'content-length') return len;
            return null;
          },
        },
        json: async () => ({}),
        text: async () => r.text ?? '',
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        // 真给一条流：`readCapped` 的「边读边判上限」分支才真的被执行到
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      } as unknown as Response;
    }),
  );
}

function silentCtx(): { ctx: ToolContext; steps: Array<{ tool: string; status: string; detail?: string }> } {
  const steps: Array<{ tool: string; status: string; detail?: string }> = [];
  return { ctx: { onStep: (tool, status, detail) => steps.push({ tool, status, detail }), ownerId: null }, steps };
}

/** 缓存目录里的文件数：拒绝路径必须为 0。 */
const cacheCount = (): number => (fs.existsSync(imagesDir()) ? fs.readdirSync(imagesDir()).length : 0);

beforeEach(() => {
  calls.length = 0;
  fs.rmSync(imagesDir(), { recursive: true, force: true });
});

afterEach(() => vi.unstubAllGlobals());

describe('fetch_image — 元数据（§4.2：分档超时 / 重试资格 / 确认门缺省的共同事实源）', () => {
  it('network + 幂等（⇒ 免确认）；不设 timeoutMs（档位基线不动）；无 planWrite', () => {
    const m = toolMeta('fetch_image');
    expect(m?.kind).toBe('network');
    expect(m?.idempotent).toBe(true); // 同内容落到同一 hash ⇒ 重放无副作用，够重试资格
    expect(m?.timeoutMs).toBeUndefined();
    expect(m?.needsConfirm).toBeUndefined(); // 缺省由 kind 推，注册方不重复声明
    expect(m?.planWrite).toBeUndefined(); // 非「改用户数据」的写门面
  });
});

describe('fetch_image — 成功路径', () => {
  it('PNG → 回灌站内相对地址，且文件真的落了盘', async () => {
    mockFetch(() => ({ bytes: PNG, contentType: 'image/png' }));
    const { ctx, steps } = silentCtx();
    const r = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/pic.png' }), ctx);

    const m = r.content.match(/\/api\/images\/([a-f0-9]{32}\.png)/);
    expect(m, '回灌里必须有站内图片地址').not.toBeNull();
    expect(cacheCount()).toBe(1);
    expect(fs.existsSync(path.join(imagesDir(), m![1]!))).toBe(true); // 不是只回了个假地址
    expect(steps.at(-1)).toMatchObject({ tool: 'fetch_image', status: 'done' });
  });

  it('★ 回灌必须教「怎么写进正文」——只说取到了，模型会裸写地址、学习者看不到图', async () => {
    mockFetch(() => ({ bytes: PNG, contentType: 'image/png' }));
    const r = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/pic.png' }), silentCtx().ctx);

    expect(r.content).toContain('Markdown 图片语法');
    expect(r.content).toContain('![一句话说明这张图]'); // 给可照抄的整段样板
    expect(r.content).not.toContain('我无法');
  });

  it('★ 服务端把图片声明成 octet-stream 也要能搬（判在字节上，图床常态）', async () => {
    // 同 fetch_page 的教训反向应用：那边「谎报类型」要拒（防二进制冒充正文），
    // 这边目标本就是取图 ⇒ 声明什么不重要，**字节是图片就搬**
    mockFetch(() => ({ bytes: PNG, contentType: 'application/octet-stream' }));
    const r = await runTool('fetch_image', JSON.stringify({ url: 'https://cdn.example/x' }), silentCtx().ctx);
    expect(r.content).toContain('/api/images/');
    expect(cacheCount()).toBe(1);
  });

  it('同 URL 连调两次 → 地址完全相同、缓存仍只有一个文件（幂等的实现，不是声明）', async () => {
    mockFetch(() => ({ bytes: PNG, contentType: 'image/png' }));
    const a = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/pic.png' }), silentCtx().ctx);
    const b = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/pic.png' }), silentCtx().ctx);
    const srcOf = (s: string) => s.match(/\/api\/images\/[a-f0-9]{32}\.\w+/)?.[0];
    expect(srcOf(a.content)).toBe(srcOf(b.content));
    expect(cacheCount()).toBe(1);
  });
});

describe('fetch_image — 拒绝路径（一律零落盘）', () => {
  it('HTML 字节 → 如实说不是图片，且一个文件都不落', async () => {
    mockFetch(() => ({ bytes: new TextEncoder().encode('<html><body>hello</body></html>'), contentType: 'text/html' }));
    const r = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/page' }), silentCtx().ctx);
    expect(r.content).toContain('不是本工具能搬运的图片');
    expect(r.content).toContain('不要因此说这个地址不存在'); // B-006：不给放弃台阶、不许编造
    expect(cacheCount()).toBe(0);
  });

  it('★ SVG 单列说明（它是文本、无魔数，不点明的话用户只会觉得工具坏了）', async () => {
    mockFetch(() => ({
      bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      contentType: 'image/svg+xml',
    }));
    const r = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/x.svg' }), silentCtx().ctx);
    expect(r.content).toContain('SVG');
    expect(r.content).toContain('不搬运'); // 「刻意不搬」的理由要说出来
    expect(cacheCount()).toBe(0);
  });

  it('服务端声明超大 → 当场拒、文案给上限与出处，且不落盘', async () => {
    mockFetch(() => ({ bytes: PNG, contentType: 'image/png', contentLength: String(5 * 1024 * 1024) }));
    const r = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/huge.png' }), silentCtx().ctx);
    expect(r.content).toContain('4 MB');
    expect(r.content).toContain('5.0 MB');
    expect(cacheCount()).toBe(0);
  });

  it('★ 不给 content-length 但实际超限 → 流式限长拦下（谎报体量不该能打穿内存）', async () => {
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1024);
    huge.set(PNG.subarray(0, 8), 0); // 头部是合法 PNG：单靠嗅探会放行，必须由上限拦
    mockFetch(() => ({ bytes: huge, contentType: 'image/png', contentLength: null }));
    const r = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/lie.png' }), silentCtx().ctx);
    expect(r.content).toContain('4 MB');
    expect(cacheCount()).toBe(0);
  });

  it('URL 为空 → 提示带 url 重调，且一次请求都不发', async () => {
    mockFetch(() => ({ bytes: PNG, contentType: 'image/png' }));
    const r = await runTool('fetch_image', JSON.stringify({ url: '   ' }), silentCtx().ctx);
    expect(r.content).toContain('网址为空');
    expect(calls.length).toBe(0);
  });

  it('HTTP 404 → 如实报状态码，且显式禁止说成「这张图不存在」', async () => {
    mockFetch(() => ({ status: 404 }));
    const r = await runTool('fetch_image', JSON.stringify({ url: 'https://a.example/gone.png' }), silentCtx().ctx);
    expect(r.content).toContain('404');
    expect(r.content).toContain('不要因此说这张图不存在');
    expect(cacheCount()).toBe(0);
  });
});

describe('fetch_image — 安全', () => {
  it('★ 内网地址被拦后，回灌文案不含该地址与端口，且 fetch 根本没被调用', async () => {
    mockFetch(() => ({ bytes: PNG, contentType: 'image/png' }));
    const { ctx } = silentCtx();
    const r = await runTool('fetch_image', JSON.stringify({ url: 'http://127.0.0.1:8080/admin.png' }), ctx);

    expect(r.content).not.toContain('127.0.0.1');
    expect(r.content).not.toContain('8080');
    expect(r.content).toContain('该地址不被允许访问');
    expect(calls.length).toBe(0); // 拦在发请求之前，不是发完再判
    expect(cacheCount()).toBe(0);
  });

  it('非 http(s) 协议同样拦下', async () => {
    mockFetch(() => ({ bytes: PNG, contentType: 'image/png' }));
    const r = await runTool('fetch_image', JSON.stringify({ url: 'file:///C:/secret.png' }), silentCtx().ctx);
    expect(r.content).toContain('该地址不被允许访问');
    expect(calls.length).toBe(0);
  });
});
