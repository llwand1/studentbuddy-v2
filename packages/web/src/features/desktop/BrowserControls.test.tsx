// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({host:false,post:vi.fn()}));
vi.mock('./desktop-api',()=>({desktopApi:{browser:async()=>({page:null})}}));
vi.mock('../../lib/api',()=>({api:{sessions:{list:async()=>[]}}}));
vi.mock('../float/float-view',()=>({hasHost:()=>fake.host,postToHost:fake.post}));
vi.mock('./BrowserPicker',()=>({BrowserPicker:()=>null}));
import { BrowserControls } from './BrowserControls';
afterEach(()=>{cleanup();fake.host=false;vi.clearAllMocks();});
it('puts a real ZIP download at the first level and enables connection only when the browser extension is ready',async()=>{
  render(<BrowserControls sessionId="session"/>);
  const download=screen.getByRole('link',{name:'下载共读扩展 ZIP'});
  expect(download.getAttribute('href')).toBe('/desktop-reader-extension.zip');
  expect(download.closest('details')).toBeNull();expect(download.getAttribute('download')).toBe('StudentBuddy-reader-extension.zip');
  const setup=document.createElement('div');setup.innerHTML=readFileSync('packages/web/public/desktop-reader-connect.html','utf8');document.body.append(setup);
  const connect=setup.querySelector('#reader-connect') as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  const copy=vi.fn().mockResolvedValue(undefined);
  runInNewContext(readFileSync('packages/web/public/desktop-reader-connect.js','utf8'),{document,navigator:{userAgent:'Edg/130',clipboard:{writeText:copy}},MutationObserver});
  fireEvent.click(setup.querySelector('#reader-copy-manager')!);await waitFor(()=>expect(copy).toHaveBeenCalledWith('edge://extensions'));
  setup.querySelector('#reader-status')!.textContent='扩展已就绪，点击连接';
  await waitFor(()=>expect(connect.disabled).toBe(false));expect((setup.querySelector('#reader-install') as HTMLDetailsElement).open).toBe(false);setup.remove();
});
it('also opens the actual installed folder without making the user search advanced settings',()=>{
  fake.host=true;render(<BrowserControls sessionId="session"/>);const button=screen.getByRole('button',{name:'打开已安装的扩展文件夹'});
  expect(button.closest('details')).toBeNull();fireEvent.click(button);expect(fake.post).toHaveBeenCalledWith('sb-desktop:extension');
});
