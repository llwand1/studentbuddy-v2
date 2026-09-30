import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { preparePackage } from './prepare-package.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studentbuddy-package-'));
  const filename = 'StudentBuddy-0.1.0-windows-x64-setup.exe';
  const bytes = Buffer.from('installer fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(root, filename), bytes);
  await writeFile(path.join(root, 'SHA256SUMS.txt'), `\uFEFF${sha256}  ${filename}\r\n`);
  return { version: '0.1.0', assets: root, output: path.join(root, 'package'), filename, sha256 };
}

test('package includes verified installer and links to the repository', async () => {
  const options = await fixture();
  const manifest = await preparePackage(options);
  assert.equal(manifest.name, '@llwand1/studentbuddy-windows');
  assert.equal(manifest.repository.url, 'https://github.com/llwand1/studentbuddy-v2.git');
  assert.equal(manifest.studentbuddy.sha256, options.sha256);
  assert.equal(manifest.scripts, undefined);
  const require = createRequire(import.meta.url);
  const { verifiedInstaller } = require(path.join(options.output, 'install.cjs'));
  assert.equal(verifiedInstaller(), path.join(options.output, options.filename));
  const cli = spawnSync(process.execPath, [path.join(options.output, 'install.cjs'), '--path'], { encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.equal(cli.stdout.trim(), verifiedInstaller());
  assert.match(await readFile(path.join(options.output, 'LICENSE'), 'utf8'), /MIT License/);
  await writeFile(path.join(options.output, options.filename), 'tampered');
  assert.throws(verifiedInstaller, /verification failed/);
});

test('corrupt or ambiguous release checksums are rejected', async () => {
  const options = await fixture();
  await writeFile(path.join(options.assets, options.filename), 'corrupt');
  await assert.rejects(preparePackage(options), /mismatch/);
  const line = `${options.sha256}  ${options.filename}\n`;
  await writeFile(path.join(options.assets, 'SHA256SUMS.txt'), line + line);
  await assert.rejects(preparePackage(options), /exactly one/);
});

test('invalid versions and existing output directories are rejected', async () => {
  const options = await fixture();
  for (const version of ['../0.1.0', '01.1.0', '0.1.0-beta', '0.1.0\n']) {
    await assert.rejects(preparePackage({ ...options, version }), /Invalid/);
  }
  await preparePackage(options);
  await assert.rejects(preparePackage(options), /EEXIST/);
});
