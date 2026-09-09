/* eslint-disable @typescript-eslint/no-require-imports -- vi.hoisted 工厂被 hoist 到 import 语句之前，只能用 require 同步取模块（见下方注释），ESM 动态 import 在此处不可用 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 用 vi.hoisted 让 HOME 在 vi.mock 工厂（会被 hoist 到文件顶部）执行前就初始化，
// 避免工厂闭包引用到 TDZ 里的 HOME。回调必须自包含：vitest 的 import 被 hoist 成
// __vi_import_* 变量，hoisted 回调先于它们初始化，故这里直接用 require 取 fs / path。
const { HOME } = vi.hoisted(() => {
  const f = require('node:fs') as typeof import('node:fs');
  const p = require('node:path') as typeof import('node:path');
  return { HOME: f.mkdtempSync(p.join(require('node:os').tmpdir(), 'sb-home-')) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, homedir: () => HOME };
  return { ...mocked, default: mocked }; // 同时覆盖具名导出与默认导出（db.ts 用默认导入）
});

import { resolveDataDir } from './db.js';

const db = (dir: string) => path.join(dir, 'studentbuddy.db');

describe('storage/db — resolveDataDir 优先复用已存在的真实库（根治反复启动后没数据）', () => {
  beforeEach(() => {
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(HOME, { recursive: true });
    delete process.env.SB_DATA_DIR;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
  });
  afterAll(() => {
    fs.rmSync(HOME, { recursive: true, force: true });
  });

  it('SB_DATA_DIR 最高优先级，直接返回且不被候选逻辑覆盖', () => {
    process.env.SB_DATA_DIR = 'C:/override/dir';
    expect(resolveDataDir()).toBe('C:/override/dir');
  });

  it('APPDATA 存在且无现存库时，落在 APPDATA/studentbuddy-v2', () => {
    process.env.APPDATA = path.join(HOME, 'AppData', 'Roaming');
    expect(resolveDataDir()).toBe(path.join(HOME, 'AppData', 'Roaming', 'studentbuddy-v2'));
  });

  it('无 APPDATA 时，若 homedir/AppData/Roaming 已有库，则优先真实库而非 homedir 兜底空壳', () => {
    const real = path.join(HOME, 'AppData', 'Roaming', 'studentbuddy-v2');
    const stale = path.join(HOME, 'studentbuddy-v2');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(db(real), ''); // 真实库已存在
    expect(resolveDataDir()).toBe(real);
    expect(resolveDataDir()).not.toBe(stale); // 绝不退化到空壳库
  });

  it('所有候选都不存在库文件时，回退首个候选且不抛错（首次启动新建场景）', () => {
    expect(resolveDataDir()).toBe(path.join(HOME, 'AppData', 'Roaming', 'studentbuddy-v2'));
  });
});
