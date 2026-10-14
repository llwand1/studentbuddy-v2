import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readerExtensionArchive, READER_EXTENSION_FILES, zipCrc32 } from './extension-download.js';
const directory = resolve('tools/browser-extension');
function entries(zip:Buffer) {
  const result = new Map<string,Buffer>(); let offset = 0;
  while (zip.readUInt32LE(offset)===0x04034b50) {
    const length=zip.readUInt32LE(offset+18), names=zip.readUInt16LE(offset+26), name=zip.subarray(offset+30,offset+30+names).toString();
    const content=zip.subarray(offset+30+names,offset+30+names+length);
    expect(zip.readUInt16LE(offset+8)).toBe(0); expect(zip.readUInt32LE(offset+14)).toBe(zipCrc32(content));
    result.set(name,content); offset+=30+names+length;
  }
  expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
  const end=zip.length-22;expect(zip.readUInt32LE(end)).toBe(0x06054b50);expect(zip.readUInt32LE(end+16)).toBe(offset);expect(zip.readUInt16LE(end+10)).toBe(result.size);
  return result;
}
it('downloads a valid deterministic ZIP with manifest directly at its root and only public extension files',()=>{
  const zip=readerExtensionArchive(directory), files=entries(zip);
  expect(zipCrc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  expect([...files.keys()]).toEqual([...READER_EXTENSION_FILES]);
  for(const name of READER_EXTENSION_FILES)expect(files.get(name)).toEqual(readFileSync(join(directory,name)));
  expect(JSON.parse(files.get('manifest.json')!.toString()).version).toBe('1.1.1');
  expect(readerExtensionArchive(directory)).toEqual(zip);
});
it('refuses incomplete or oversized bundles rather than exporting unrelated files',()=>{
  const root=mkdtempSync(join(tmpdir(),'sb-extension-download-'));
  expect(()=>readerExtensionArchive(root)).toThrow();
  writeFileSync(join(root,'manifest.json'),'{}');expect(()=>readerExtensionArchive(root)).toThrow('清单');
  for(const name of READER_EXTENSION_FILES)copyFileSync(join(directory,name),join(root,name));
  writeFileSync(join(root,'background.js'),Buffer.alloc(256*1024+1));expect(()=>readerExtensionArchive(root)).toThrow('不完整');
});
it.skipIf(process.platform==='win32')('refuses symlinks in the public bundle',()=>{
  const root=mkdtempSync(join(tmpdir(),'sb-extension-link-'));
  symlinkSync(join(directory,'manifest.json'),join(root,'manifest.json'));expect(()=>readerExtensionArchive(root)).toThrow('不完整');
});
process.env.SB_DATA_DIR=mkdtempSync(join(tmpdir(),'sb-extension-route-'));
const {app}=await import('../index.js');const {closeDb}=await import('../storage/db.js');const request=(await import('supertest')).default;
afterAll(()=>closeDb());
it('serves the ZIP as an explicit download only on the desktop loopback surface',async()=>{
  const old=process.env.SB_WEB_DIST, desktop=process.env.SB_DESKTOP;
  process.env.SB_WEB_DIST=resolve('tools/desktop');process.env.SB_DESKTOP='1';
  try {
    const response=await request(app).get('/desktop-reader-extension.zip?file=../../private').buffer(true).parse((res,done)=>{
      const chunks:Buffer[]=[];res.on('data',(chunk:Buffer)=>chunks.push(chunk));res.on('end',()=>done(null,Buffer.concat(chunks)));res.on('error',(error:Error)=>done(error,undefined));
    }).expect(200);
    expect(response.headers['content-type']).toContain('application/zip');expect(response.headers['content-disposition']).toContain('StudentBuddy-reader-extension.zip');
    expect([...entries(response.body as Buffer).keys()]).toEqual([...READER_EXTENSION_FILES]);
    process.env.SB_DESKTOP='0';await request(app).get('/desktop-reader-extension.zip').expect(404);
  } finally { if(old===undefined)delete process.env.SB_WEB_DIST;else process.env.SB_WEB_DIST=old;if(desktop===undefined)delete process.env.SB_DESKTOP;else process.env.SB_DESKTOP=desktop; }
});
