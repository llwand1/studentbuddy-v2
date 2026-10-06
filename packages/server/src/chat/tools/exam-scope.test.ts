import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SseEvent } from '@sb/shared';
import { openIsolated, closeDb } from '../../storage/db.js';
import { saveExamScope, readExamModeView } from '../../learning/exam-mode.js';
import { runTool, toolMeta, toolDefinitions } from './index.js';
import { snapshot } from '../sse-bus.js';
import { pendingConfirmCount, resolveConfirmation } from './confirm.js';
import type { ToolContext } from './registry.js';
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-examscope-'));
  openIsolated(dir);
  saveExamScope({ packs: ['gaokao'], custom: ['old.example.org'] }, 'alice');
});
afterEach(() => { expect(pendingConfirmCount()).toBe(0); closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });
const ctx = (ownerId = 'alice', signal?: AbortSignal): ToolContext => ({ ownerId, sessionId: randomUUID(), onStep: () => {}, signal });
type Frame = Extract<SseEvent, { type: 'tool-confirm-request' }>;
async function frame(sid: string): Promise<Frame> {
  for (let n = 0; n < 10; n++) {
    await new Promise(r => setTimeout(r, 0));
    const f = snapshot(sid).find((e): e is Frame => e.type === 'tool-confirm-request');
    if (f) return f;
  }
  throw new Error('未发出确认卡');
}
const run = (args: Record<string, unknown>, c = ctx()) => runTool('update_exam_scope', JSON.stringify(args), c);
describe('AI 应试白名单：真实确认门与按账号写入', () => {
  it('两工具均下发给模型，写工具必确认；只读可查看关闭状态的配置', async () => {
    const names = toolDefinitions().map(t => t.function.name);
    expect(names).toContain('read_exam_scope'); expect(names).toContain('update_exam_scope'); expect(names.length).toBeLessThanOrEqual(16);
    expect(toolMeta('update_exam_scope')?.needsConfirm).toBe(true);
    const r = JSON.parse((await runTool('read_exam_scope', '{}', ctx())).content);
    expect(r.on).toBe(false); expect(r.scope.custom).toEqual(['old.example.org']);
    expect(r.availablePacks.some((p: { id: string }) => p.id === 'gaokao')).toBe(true);
  });
  it('批准前零改动；批准后增删与开关原子保存，保留其它类目与另一账号', async () => {
    const before = readExamModeView('alice'), bob = readExamModeView('bob'), c = ctx();
    const pending = run({ on: true, addHosts: ['https://www.new.example.org/path'], removeHosts: ['old.example.org'] }, c);
    const f = await frame(c.sessionId!);
    expect(readExamModeView('alice')).toEqual(before);
    expect(f.items.join(' ')).toContain('new.example.org');
    resolveConfirmation(f.requestId, 'allow_once');
    expect((await pending).meta?.affected).toBe(3);
    expect(readExamModeView('alice').scope).toEqual({ packs: ['gaokao'], custom: ['new.example.org'] });
    expect(readExamModeView('alice').on).toBe(true); expect(readExamModeView('bob')).toEqual(bob);
  });
  it('拒绝不改配置', async () => {
    const before = readExamModeView('alice'), c = ctx(), pending = run({ setPacks: [], setHosts: [], on: true }, c);
    resolveConfirmation((await frame(c.sessionId!)).requestId, 'deny'); await pending;
    expect(readExamModeView('alice')).toEqual(before);
  });
  it('等待期间界面改设置，中止整批且不覆盖新值', async () => {
    const c = ctx(), pending = run({ addHosts: ['new.example.org'], on: true }, c);
    const f = await frame(c.sessionId!);
    saveExamScope({ packs: ['kaoyan'], custom: ['ui.example.org'] }, 'alice');
    resolveConfirmation(f.requestId, 'allow_once');
    expect((await pending).content).toContain('整批中止');
    expect(readExamModeView('alice').scope.custom).toEqual(['ui.example.org']); expect(readExamModeView('alice').on).toBe(false);
  });
  it('中止生成不落库', async () => {
    const controller = new AbortController(), before = readExamModeView('alice'), c = ctx('alice', controller.signal);
    const pending = run({ on: true }, c); await frame(c.sessionId!); controller.abort(); await pending;
    expect(readExamModeView('alice')).toEqual(before);
  });
  it.each([
    { addHosts: ['127.0.0.1'] }, { addHosts: ['valid.example.org', 'localhost'] }, { addPacks: ['bad-id'] },
    { setHosts: [], addHosts: ['a.example.org'] }, { addHosts: ['same.example.org'], removeHosts: ['same.example.org'] },
    { setHosts: Array.from({ length: 25 }, (_, i) => `s${i}.example.org`) },
  ])('非法整批不弹空确认卡、不写入：%j', async args => {
    const before = readExamModeView('alice'); expect((await run(args)).content).toContain('未修改');
    expect(readExamModeView('alice')).toEqual(before); expect(pendingConfirmCount()).toBe(0);
  });
  it('超出已有域名总量也拒绝，重复项无变化不弹卡', async () => {
    expect((await run({ addHosts: Array.from({ length: 24 }, (_, i) => `s${i}.example.org`) })).content).toContain('最多');
    expect((await run({ addHosts: ['old.example.org'], addPacks: ['gaokao'] })).content).toContain('无需修改');
  });
});
