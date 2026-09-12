/**
 * chat/tools — manage_terms 工具回归（词条直接写路径）。
 * 不触 LLM：tidy_terms 等在别处已覆盖，这里只测 manage_terms 的参数校验与落库语义。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb } from '../storage/db.js';
import { runTool, toolDefinitions } from './tools.js';
import { saveOneTerm, findTermByName, listTerms } from '../learning/terms.js';
import type { ToolContext } from './tools.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tools-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 收集 step 事件的哑回调（顺带可断言上屏详情） */
function makeCtx(): { ctx: ToolContext; steps: Array<{ tool: string; status: string; detail?: string }> } {
  const steps: Array<{ tool: string; status: string; detail?: string }> = [];
  return { ctx: { onStep: (tool, status, detail) => steps.push({ tool, status, detail }) }, steps };
}

describe('chat/tools — manage_terms 注册与定义', () => {
  it('注册表包含 manage_terms 且定义完整', () => {
    const defs = toolDefinitions();
    const def = defs.find((t) => t.function.name === 'manage_terms');
    expect(def).toBeTruthy();
    expect(def?.function.parameters).toBeTruthy();
  });
});

describe('chat/tools — manage_terms add', () => {
  it('正常添加：落库且可按名查到', async () => {
    const { ctx } = makeCtx();
    const r = await runTool('manage_terms', JSON.stringify({ action: 'add', term: '闭包', definition: '函数与其词法环境的组合', domain: 'cs' }), ctx);
    expect(r.content).toContain('闭包');
    const hit = findTermByName('闭包');
    expect(hit?.definition).toBe('函数与其词法环境的组合');
    expect(hit?.domain).toBe('cs');
  });

  it('缺 definition → 报错回灌，不落库', async () => {
    const { ctx } = makeCtx();
    const r = await runTool('manage_terms', JSON.stringify({ action: 'add', term: '闭包' }), ctx);
    expect(r.content).toContain('add 需要');
    expect(findTermByName('闭包')).toBeNull();
  });

  it('重复添加同名 → 覆盖释义不新建（防再分裂语义）', async () => {
    const { ctx } = makeCtx();
    await runTool('manage_terms', JSON.stringify({ action: 'add', term: 'closure', definition: 'v1 释义' }), ctx);
    await runTool('manage_terms', JSON.stringify({ action: 'add', term: 'CLOSURE', definition: '更新后的释义' }), ctx);
    const rows = listTerms();
    expect(rows.filter((r) => r.term.toLowerCase() === 'closure')).toHaveLength(1);
    expect(rows[0]?.definition).toBe('更新后的释义');
  });
});

describe('chat/tools — manage_terms update', () => {
  it('按名（大小写不敏感）改释义与重要度', async () => {
    const { ctx } = makeCtx();
    saveOneTerm('闭包', '旧释义', 'cs');
    const r = await runTool('manage_terms', JSON.stringify({ action: 'update', term: '闭包', definition: '新释义', importance: 0.9 }), ctx);
    expect(r.content).toContain('已更新');
    const hit = findTermByName('闭包');
    expect(hit?.definition).toBe('新释义');
    expect(hit?.importance).toBe(0.9);
  });

  it('词条不存在 → 提示可 add，不崩', async () => {
    const { ctx } = makeCtx();
    const r = await runTool('manage_terms', JSON.stringify({ action: 'update', term: '不存在', definition: 'x' }), ctx);
    expect(r.content).toContain('没找到');
  });

  it('不带任何要改的字段 → 报错回灌', async () => {
    const { ctx } = makeCtx();
    saveOneTerm('闭包', '旧释义');
    const r = await runTool('manage_terms', JSON.stringify({ action: 'update', term: '闭包' }), ctx);
    expect(r.content).toContain('至少要给');
  });
});

describe('chat/tools — manage_terms delete', () => {
  it('单个删除与批量删除（含未找到的如实汇报）', async () => {
    const { ctx } = makeCtx();
    saveOneTerm('闭包', 'x');
    saveOneTerm('递归', 'y');
    const r1 = await runTool('manage_terms', JSON.stringify({ action: 'delete', term: '闭包' }), ctx);
    expect(r1.content).toContain('已删除 1 条');
    expect(findTermByName('闭包')).toBeNull();
    const r2 = await runTool('manage_terms', JSON.stringify({ action: 'delete', terms: ['递归', '没有的词'] }), ctx);
    expect(r2.content).toContain('已删除 1 条');
    expect(r2.content).toContain('词条库里没有：没有的词');
  });

  it('没给词条名 → 报错回灌', async () => {
    const { ctx } = makeCtx();
    const r = await runTool('manage_terms', JSON.stringify({ action: 'delete' }), ctx);
    expect(r.content).toContain('delete 需要');
  });
});

describe('chat/tools — manage_terms 其它', () => {
  it('未知 action → 报错回灌', async () => {
    const { ctx } = makeCtx();
    const r = await runTool('manage_terms', JSON.stringify({ action: 'nuke' }), ctx);
    expect(r.content).toContain('add / update / delete');
  });

  it('参数 JSON 解析失败 → 统一报错（runTool 既有语义）', async () => {
    const { ctx } = makeCtx();
    const r = await runTool('manage_terms', 'not-json', ctx);
    expect(r.content).toContain('JSON 解析失败');
  });
});
