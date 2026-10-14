import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.SB_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'sb-browser-pref-'));
const fake=vi.hoisted(()=>({exists:vi.fn(()=>true),spawn:vi.fn()}));
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>(),existsSync:fake.exists}));
vi.mock('node:child_process',()=>({spawn:fake.spawn}));
const {browserPaths,browserPreference,savePreferredBrowser,openReaderBrowser,githubBrowserEnvironment}=await import('./browser-launch.js');
const {closeDb}=await import('../storage/db.js');
beforeEach(()=>{
  vi.stubGlobal('process',Object.create(process,{platform:{value:'win32'}}));vi.stubEnv('SB_DESKTOP','1');
  vi.stubEnv('ProgramFiles','C:/Program Files');vi.stubEnv('LOCALAPPDATA','C:/local');fake.exists.mockReturnValue(true);fake.spawn.mockReset();
  fake.spawn.mockImplementation(()=>{const child=Object.assign(new EventEmitter(),{unref:vi.fn()});queueMicrotask(()=>child.emit('spawn'));return child;});
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});afterAll(()=>closeDb());
it('persists a fixed installed browser per owner without changing data location or OS default',()=>{
  savePreferredBrowser('one','chrome');savePreferredBrowser('two','edge');
  expect(browserPreference('one').selected).toBe('chrome');expect(browserPreference('two').selected).toBe('edge');
  expect(()=>savePreferredBrowser('one','powershell')).toThrow('选择');
  fake.exists.mockReturnValue(false);expect(()=>savePreferredBrowser('one','edge')).toThrow('未找到');
  expect(browserPreference('one').selected).toBe('chrome');
  expect(browserPaths('chrome',{ProgramFiles:'fixed'})).toEqual([path.join('fixed','Google','Chrome','Application','chrome.exe')]);
});
it('launches only a literal loopback handoff argument in the chosen browser, never a shell command',async()=>{
  savePreferredBrowser('launch','chrome');const address='http://127.0.0.1:18794/desktop-reader-connect.html#ABCD123456';
  await openReaderBrowser('launch',address);
  expect(fake.spawn).toHaveBeenCalledWith(expect.stringContaining('chrome.exe'),[address],expect.objectContaining({shell:false,windowsHide:true}));
  for(const bad of ['https://evil.invalid/#ABCD123456','http://127.0.0.1:18794/api/chat#ABCD123456',address+'?command',address.replace('#ABCD123456','?code=ABCD123456')]) await expect(openReaderBrowser('launch',bad)).rejects.toThrow();
  expect(fake.spawn).toHaveBeenCalledTimes(1);
});
it('scopes the official OAuth adapter to one child with a validated browser and immutable path',()=>{
  savePreferredBrowser('oauth','edge');const env={Path:'original',SB_GITHUB_BROWSER:'powershell',KEEP:'yes'};
  const selected=githubBrowserEnvironment('oauth','fixed-integration',env);
  expect(selected.SB_GITHUB_BROWSER).toBe('edge');expect(selected.PATH).toBe(path.resolve('fixed-integration','browser-launch')+path.delimiter+'original');expect(selected.Path).toBeUndefined();
  expect(env.Path).toBe('original');expect(selected.KEEP).toBe('yes');
});
