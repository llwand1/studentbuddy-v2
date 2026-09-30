import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));

export async function preparePackage({ version, assets, output }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Invalid desktop version.');
  }
  const filename = `StudentBuddy-${version}-windows-x64-setup.exe`;
  const source = path.resolve(assets, filename);
  const checksums = await readFile(path.resolve(assets, 'SHA256SUMS.txt'), 'utf8');
  const entries = checksums.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    .map(line => /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line))
    .filter(entry => entry && entry[2] === filename);
  if (entries.length !== 1) throw new Error('Expected exactly one installer checksum.');
  const sha256 = createHash('sha256').update(await readFile(source)).digest('hex');
  if (sha256 !== entries[0][1].toLowerCase()) throw new Error('Installer SHA-256 mismatch.');
  // A fresh directory prevents stale files from entering the published tarball.
  await mkdir(output, { recursive: false });
  const template = path.join(toolDir, 'npm-package');
  const manifest = JSON.parse(await readFile(path.join(template, 'package.json'), 'utf8'));
  manifest.version = version;
  manifest.homepage = `https://github.com/llwand1/studentbuddy-v2/releases/tag/desktop-v${version}`;
  manifest.studentbuddy = { installer: filename, sha256 };
  await copyFile(source, path.join(output, filename));
  await copyFile(path.resolve(toolDir, '../../LICENSE'), path.join(output, 'LICENSE'));
  for (const name of ['install.cjs', 'README.md']) {
    await copyFile(path.join(template, name), path.join(output, name));
  }
  await writeFile(path.join(output, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`);
  await writeFile(path.join(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, assets, output, ...extra] = process.argv.slice(2);
  if (!version || !assets || !output || extra.length) {
    throw new Error('Usage: node tools/desktop/prepare-package.mjs <version> <assets-dir> <new-output-dir>');
  }
  await preparePackage({ version, assets, output });
  console.log(`Prepared @llwand1/studentbuddy-windows@${version}`);
}
