import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, UNKNOWN_VERSION, readPackageVersion } from './version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'package.json'), 'utf8')) as { version: string };

describe('version：/api/status 报的号来自 package.json，全仓只有一个版本号', () => {
  it('VERSION 等于根 package.json 的 version（workspace 与根同号由 tools/check-version.mjs 对账）', () => {
    expect(VERSION).toBe(rootPkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(VERSION).not.toBe(UNKNOWN_VERSION);
  });

  it('源码里不再有手抄的版本字面量（改号只改 package.json）', () => {
    const src = fs.readFileSync(path.join(here, 'version.ts'), 'utf8');
    expect(src).not.toMatch(/\bVERSION\s*=\s*['"]\d+\.\d+\.\d+['"]/);
  });

  it('读不到 / 形状不对时回落 0.0.0-unknown 而不是抛（版本号不该让服务起不来）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-version-'));
    const sub = path.join(tmp, 'src');
    fs.mkdirSync(sub);
    expect(readPackageVersion(sub)).toBe(UNKNOWN_VERSION);
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version": 42}');
    expect(readPackageVersion(sub)).toBe(UNKNOWN_VERSION);
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version": "1.2.3"}');
    expect(readPackageVersion(sub)).toBe('1.2.3');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
