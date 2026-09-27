/**
 * chat/tools/generate-image 单测 —— 工具壳层（契约 `docs/IMAGE-GEN-SPEC.md` §3）：
 * 注册元数据（kind/idempotent 是钱的声明）、回灌文案口径、onStep 事件序列、
 * 以及那把锁——**系统提示词必须一并带上 generate_image 的引导**（漏写＝能力对模型不存在）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../../storage/db.js';
import { resetUpstreamGates } from '../../llm/upstream-gate.js';
import { toolMeta } from './registry.js';
import { runTool, toolNames } from './index.js';
import { IMAGE_PROMPT_MAX_CHARS } from '../../llm/image-gen.js';
import { SYSTEM_PROMPT } from '../system-prompt.js';

let dir: string;
const envBackup: Record<string, string | undefined> = {};

/** 收集 onStep 事件的最小 ToolContext（工具壳层测试不真连上游的分支都够用）。 */
const events: Array<{ tool: string; status: string; detail?: string }> = [];
function makeCtx(ownerId: string | null) {
  events.length = 0;
  return {
    onStep: (tool: string, status: 'running' | 'done' | 'error', detail?: string) => {
      events.push({ tool, status, detail });
    },
    ownerId,
  };
}

function pngB64(byte: number): string {
  const bytes = new Uint8Array(64).fill(byte);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return Buffer.from(bytes).toString('base64');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gen-image-tool-'));
  openIsolated(dir);
  for (const k of ['SB_PLATFORM_API_KEY', 'SB_PLATFORM_BASE_URL']) envBackup[k] = process.env[k];
  process.env.SB_PLATFORM_API_KEY = 'sk-TEST-PLATFORM';
  process.env.SB_PLATFORM_BASE_URL = 'https://agnes.test/v1';
  getDb().prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, owner_id) VALUES ('openai-default', '默认服务商', 'https://api.openai.com/v1', '', 'openai', 1, NULL)`).run();
  getDb().prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (NULL, 'image', 'openai-default', '')`).run();
  vi.stubGlobal(
    'fetch',
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ b64_json: pngB64(7) }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetUpstreamGates();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(envBackup)) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
});

describe('注册元数据', () => {
  it('generate_image 已注册、kind=network、idempotent 必须为假（每次调用都真金白银）', () => {
    expect(toolNames()).toContain('generate_image');
    const meta = toolMeta('generate_image');
    expect(meta?.kind).toBe('network');
    expect(meta?.idempotent).toBe(false);
    expect(meta?.definition.function.name).toBe('generate_image');
  });
  it('★ 系统提示词必含 generate_image 引导（能力声明与工具一并到位）', () => {
    expect(SYSTEM_PROMPT).toContain('generate_image');
    expect(SYSTEM_PROMPT).toContain('画个图');
  });
  it('★ 工具 description 必含「写进正文」的强制（同 fetch_image 口径：不教用法＝能力等于不存在）', () => {
    const desc = toolMeta('generate_image')?.definition.function.description ?? '';
    expect(desc).toContain('Markdown 图片语法');
    expect(desc).toContain('不要编造');
  });
});

describe('run — 回灌与事件', () => {
  it('成功：回灌含站内地址与用法示范，onStep 走 running→done', async () => {
    const out = await runTool('generate_image', JSON.stringify({ prompt: '细胞结构示意图' }), makeCtx('u1'));
    expect(out.content).toContain('![一句话说明这张图](/api/images/');
    expect(out.content).toContain('KB');
    expect(events.map((e) => e.status)).toEqual(['running', 'done']);
    expect(events[0]?.tool).toBe('generate_image');
  });

  it('prompt 截断到上限后照常工作', async () => {
    const long = '画'.repeat(IMAGE_PROMPT_MAX_CHARS + 500);
    const out = await runTool('generate_image', JSON.stringify({ prompt: long }), makeCtx('u1'));
    expect(out.content).toContain('![一句话说明这张图]');
  });

  it('空 prompt：报错回灌 + error 事件，不发上游', async () => {
    const out = await runTool('generate_image', JSON.stringify({ prompt: '  ' }), makeCtx('u1'));
    expect(out.content).toContain('prompt 为空');
    expect(events.map((e) => e.status)).toEqual(['error']);
  });

  it('上游失败：失败原因如实回灌 + 不许编造的护栏句 + error 事件', async () => {
    vi.stubGlobal(
      'fetch',
      () => Promise.resolve(new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 429 })),
    );
    const out = await runTool('generate_image', JSON.stringify({ prompt: '图' }), makeCtx('u1'));
    expect(out.content).toContain('稍等十几秒'); // 翻译器的 429 文案穿壳而出
    expect(out.content).toContain('不要编造');
    expect(events[events.length - 1]?.status).toBe('error');
  });
});
