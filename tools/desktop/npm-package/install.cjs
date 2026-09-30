#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const manifest = require('./package.json');

function verifiedInstaller() {
  const { installer, sha256 } = manifest.studentbuddy;
  if (installer !== `StudentBuddy-${manifest.version}-windows-x64-setup.exe`) {
    throw new Error('Invalid installer filename.');
  }
  const file = path.join(__dirname, installer);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(sha256) || actual !== sha256) {
    throw new Error('Installer SHA-256 verification failed.');
  }
  return file;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--path')) {
      throw new Error('Usage: studentbuddy-install [--path]');
    }
    const file = verifiedInstaller();
    if (args[0] === '--path') console.log(file);
    else {
      if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('StudentBuddy requires Windows x64.');
      }
      const result = spawnSync(file, [], { stdio: 'inherit', shell: false });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { verifiedInstaller };
