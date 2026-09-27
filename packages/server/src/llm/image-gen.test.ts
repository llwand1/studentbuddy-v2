/**
 * llm/image-gen 单测 —— 生图适配器全链路（契约 `docs/IMAGE-GEN-SPEC.md` §2/§4/§5）。
 *
 * ★ 真库 + 真 `routeRole` + 真闸门，只桩**网络**（`globalThis.fetch`；`fetchSafe` 的 DNS 复检
 *   由 mock `node:dns/promises` 喂一个公网 IP，同 `fetch-image.test.ts` 的既有手法）——
 *   归属、凭据注入、张数闸、并发坑这些"本次真正的新逻辑"全部走真实现。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { imagesDir } from '../storage/image-cache.js';
import { resetUpstreamGates } from './upstream-gate.js';
import { generateImageForOwner, IMAGE_PROMPT_MAX_CHARS, normalizeImageSize } from './image-gen.js';
import { getProviders } from './router.js';

vi.mock('node:dns/promises', () => ({
  // fetchSafe 的逐跳复检要解析主机名——桩成恒公网 IP，测试不碰真网络
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

let dir: string;
const envBackup: Record<string, string | undefined> = {};

/** 最小「PNG」：嗅探表只认头 8 字节签名，内容无所谓（saveImage 落盘不需要可解码）。 */
function pngBytes(byte: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(64)).fill(byte);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

const b64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

let calls: CapturedCall[];
let fetchQueue: Array<() => Response> = [];

function respondJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-image-gen-'));
  openIsolated(dir);
  // 平台 provider 的 key/地址走 env（v39 口径：平台行 api_key 恒空）
  for (const k of ['SB_PLATFORM_API_KEY', 'SB_PLATFORM_BASE_URL', 'SB_IMAGE_MODEL', 'SB_IMAGE_DAILY_LIMIT']) {
    envBackup[k] = process.env[k];
  }
  process.env.SB_PLATFORM_API_KEY = 'sk-TEST-PLATFORM';
  process.env.SB_PLATFORM_BASE_URL = 'https://agnes.test/v1';
  delete process.env.SB_IMAGE_MODEL;
  delete process.env.SB_IMAGE_DAILY_LIMIT;
  getDb().prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, owner_id) VALUES ('openai-default', '默认服务商', 'https://api.openai.com/v1', '', 'openai', 1, NULL)`).run();
  getDb().prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (NULL, 'image', 'openai-default', '')`).run();

  calls = [];
  fetchQueue = [];
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = fetchQueue.shift();
    if (!next) return Promise.reject(new Error('no staged response'));
    return Promise.resolve(next());
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetUpstreamGates();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe('generateImageForOwner — 成功路径', () => {
  it('b64_json 落盘成站内图（凭证走 env、文件进 DATA_DIR/images、地址可进正文）', async () => {
    fetchQueue.push(() => respondJson(200, { data: [{ b64_json: b64Of(pngBytes(1)) }] }));
    const out = await generateImageForOwner('u1', '细胞结构示意图', '1024x1024');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.image.url).toMatch(/^\/api\/images\/[a-f0-9]{32}\.png$/);
    expect(out.image.ext).toBe('png');
    expect(fs.existsSync(path.join(imagesDir(), out.image.name))).toBe(true);
    // 出站请求：端点、Bearer key（env 那把）、模型默认名、b64 优先
    const call = calls[0];
    if (!call) throw new Error('unreachable：fetch 桩必然已捕获出站请求');
    expect(call.url).toBe('https://agnes.test/v1/images/generations');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-TEST-PLATFORM');
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('agnes-image-2.5-flash'); // 绑定行空 model → 常量兜底
    expect(body.response_format).toBe('b64_json');
  });

  it('url 模式：上游回地址则下载再落盘（fetchSafe 逐跳复检路径）', async () => {
    fetchQueue.push(() => respondJson(200, { data: [{ url: 'https://img.example.com/x.png' }] }));
    fetchQueue.push(() => new Response(pngBytes(2), { status: 200 }));
    const out = await generateImageForOwner('u1', '受力分析', undefined);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(calls[1]?.url).toBe('https://img.example.com/x.png');
    expect(out.image.url).toMatch(/^\/api\/images\/[a-f0-9]{32}\.png$/);
  });

  it('size 白名单外的值回落 1024x1024，不透传上游', async () => {
    fetchQueue.push(() => respondJson(200, { data: [{ b64_json: b64Of(pngBytes(3)) }] }));
    await generateImageForOwner('u1', '图', '333x333');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.size).toBe('1024x1024');
  });

  it('SB_IMAGE_MODEL 优先于常量（env > 常量）', async () => {
    process.env.SB_IMAGE_MODEL = 'agnes-image-9.9';
    fetchQueue.push(() => respondJson(200, { data: [{ b64_json: b64Of(pngBytes(4)) }] }));
    await generateImageForOwner('u1', '图', undefined);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('agnes-image-9.9');
  });

  it('BYOK 用户（自己的 provider）不受张数闸限制', async () => {
    getDb().prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, owner_id) VALUES ('p-own', 'p-own', 'https://own.example/v1', 'sk-OWN', 'openai', 1, 'u1')`).run();
    getDb().prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES ('u1', 'image', 'p-own', 'img-x')`).run();
    process.env.SB_IMAGE_DAILY_LIMIT = '0'; // 平台通道都关了，BYOK 也该照常能画
    fetchQueue.push(() => respondJson(200, { data: [{ b64_json: b64Of(pngBytes(5)) }] }));
    const out = await generateImageForOwner('u1', '图', undefined);
    expect(out.ok).toBe(true);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-OWN');
  });
});

describe('generateImageForOwner — 闸门与失败', () => {
  it('平台日限到顶：拒绝且**不发起上游请求**', async () => {
    process.env.SB_IMAGE_DAILY_LIMIT = '1';
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 19).replace('T', ' ');
    getDb().prepare(`INSERT INTO tool_stats (owner_id, session_id, tool, source, ok, affected, ms, result_chars, created_at) VALUES ('u1', 's', 'generate_image', 'builtin', 1, NULL, 1, 0, ?)`).run(day);
    const out = await generateImageForOwner('u1', '图', undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('quota');
    expect(calls).toHaveLength(0);
  });

  it('limit=0 ＝ 平台生图关闭（已知状态，文案要说清不是坏了）', async () => {
    process.env.SB_IMAGE_DAILY_LIMIT = '0';
    const out = await generateImageForOwner('u1', '图', undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('disabled');
    expect(calls).toHaveLength(0);
  });

  it('并发坑：第一张进行中时第二张得 busy', async () => {
    let release: ((r: Response) => void) | undefined;
    const gate = new Promise<Response>((r) => {
      release = r;
    });
    vi.stubGlobal('fetch', () => {
      calls.push({ url: 'pending' });
      return gate;
    });
    const first = generateImageForOwner('u1', '第一张', undefined);
    // 让第一张走到 await fetch：微任务排空一轮
    await new Promise((r) => setTimeout(r, 0));
    const second = await generateImageForOwner('u1', '第二张', undefined);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('busy');
    if (!release) throw new Error('unreachable：gate 构造器必然同步赋值');
    release(new Response(JSON.stringify({ data: [{ b64_json: b64Of(pngBytes(6)) }] }), { status: 200 }));
    expect((await first).ok).toBe(true);
  });

  it('上游 429 → 翻译成中文指引并带上游原文', async () => {
    fetchQueue.push(() => respondJson(429, { error: { message: 'rate limited' } }));
    const out = await generateImageForOwner('u1', '图', undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.message).toContain('稍等十几秒');
      expect(out.message).toContain('rate limited');
    }
  });

  it('anthropic 服务商绑生图角色：发请求前挡下（不撞必然 404）', async () => {
    getDb().prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, owner_id) VALUES ('p-anth', 'p-anth', 'https://anth.example/v1', 'sk-A', 'anthropic', 1, 'u2')`).run();
    getDb().prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES ('u2', 'image', 'p-anth', 'img-x')`).run();
    const out = await generateImageForOwner('u2', '图', undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('provider-type');
    expect(calls).toHaveLength(0);
  });

  it('没有任何 provider / 绑定：可读的「没绑定」文案', async () => {
    getDb().prepare(`DELETE FROM role_bindings WHERE role = 'image'`).run();
    getDb().prepare(`DELETE FROM providers`).run();
    const out = await generateImageForOwner('u1', '图', undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('not-bound');
      expect(out.message).toContain('生图（画图）');
    }
  });

  it('响应里既无 b64 也无 url：如实报，不落盘', async () => {
    fetchQueue.push(() => respondJson(200, { data: [{}] }));
    const out = await generateImageForOwner('u1', '图', undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('b64_json');
  });

  it('字节不是图片（嗅探不过）→ 丢弃不落盘', async () => {
    fetchQueue.push(() => respondJson(200, { data: [{ b64_json: b64Of(new Uint8Array([1, 2, 3, 4])) }] }));
    const out = await generateImageForOwner('u1', '图', undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toContain('不是可渲染的图片');
  });
});

describe('纯件', () => {
  it('normalizeImageSize 白名单回落', () => {
    expect(normalizeImageSize('1024x1792')).toBe('1024x1792');
    expect(normalizeImageSize('nonsense')).toBe('1024x1024');
    expect(normalizeImageSize(undefined)).toBe('1024x1024');
  });
  it('prompt 截断常量已声明（工具层消费）', () => {
    expect(IMAGE_PROMPT_MAX_CHARS).toBe(1000);
  });
});

describe('getProviders — type 出站（设置页生图过滤的数据源）', () => {
  it('openai/anthropic 行都带协议族出站，前端据此过滤生图角色', async () => {
    getDb().prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, owner_id) VALUES ('p-ant', 'p-ant', 'https://anth.example/v1', '', 'anthropic', 1, 'u1')`).run();
    const rows = getProviders('u1');
    const byId = new Map(rows.map((r) => [r.id, r.type]));
    expect(byId.get('openai-default')).toBe('openai');
    expect(byId.get('p-ant')).toBe('anthropic');
  });
});
