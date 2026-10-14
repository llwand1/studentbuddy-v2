import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('strict unhandled rejection mode keeps the same real server process alive after failures and a broken stream', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sb-http-process-')), fixture = join(directory, 'server.cjs');
  await build({ stdin: { resolveDir: resolve('.'), contents: `
    import express from 'express';
    import {asyncHandler} from './packages/server/src/http/async-handler.ts';
    import {createErrorBoundary} from './packages/server/src/http/error-boundary.ts';
    const app=express(); app.use(express.json());
    app.get('/reject',asyncHandler(async()=>{await Promise.resolve();throw new Error('private-token');}));
    app.get('/sentinel',asyncHandler(()=>Promise.reject('route')));
    app.get('/stream',asyncHandler(async(_req,res)=>{res.write('data: hello\\n\\n');await new Promise(r=>setTimeout(r,30));throw new Error('private-token');}));
    app.get('/health',(_req,res)=>res.json({ok:true,pid:process.pid}));
    app.use(createErrorBoundary(()=>{}));
    const server=app.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
  ` }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: fixture,
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(resolve('package.json'))});` } });
  const child = spawn(process.execPath, ['--unhandled-rejections=strict', fixture], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } });
  let diagnostics = ''; child.stderr.on('data', (data: Buffer) => { diagnostics += data.toString(); });
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      let output = ''; const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 10_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Server exited before startup')); });
      child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.includes('\n')) { clearTimeout(timeout); resolvePort((JSON.parse(output.split('\n')[0]!) as { port: number }).port); } });
    });
    const base = `http://127.0.0.1:${port}`;
    for (const route of ['/reject', '/sentinel']) {
      const response = await fetch(base + route); expect(response.status).toBe(500);
      expect((await response.json() as { code: string }).code).toBe('INTERNAL_ERROR');
    }
    expect((await (await fetch(base + '/health')).json() as { pid: number }).pid).toBe(child.pid);
    await expect(fetch(base + '/stream').then(response => response.text())).rejects.toThrow();
    const health = await fetch(base + '/health'); expect(health.status).toBe(200);
    expect((await health.json() as { pid: number }).pid).toBe(child.pid); expect(child.exitCode).toBeNull();
    expect(diagnostics).not.toContain('private-token');
  } finally { child.kill(); await new Promise<void>(resolveExit => { if (!child.pid || child.exitCode !== null || child.signalCode !== null) resolveExit(); else child.once('exit', () => resolveExit()); }); }
}, 20_000);
