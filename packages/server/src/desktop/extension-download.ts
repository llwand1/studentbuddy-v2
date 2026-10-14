import { readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
export const READER_EXTENSION_FILES = ['manifest.json','background.js','content.js','extract.js','handoff.js','popup.html','popup.js','popup.css','README.md'] as const;
export function zipCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit=0;bit<8;bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Stored ZIP entries, fixed filenames, no source folder nesting or user-supplied paths. */
export function readerExtensionArchive(directory = resolve(process.env.SB_WEB_DIST ?? 'web','..','browser-extension')): Buffer {
  const records: Buffer[] = [], central: Buffer[] = []; let offset = 0, total = 0;
  for (const name of READER_EXTENSION_FILES) {
    const file = join(directory,name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256*1024) throw new Error('网页共读扩展文件不完整');
    const data = readFileSync(file); if (data.length > 256*1024) throw new Error('网页共读扩展文件过大'); total += data.length;
    if (total > 1024*1024) throw new Error('网页共读扩展包过大');
    if (name === 'manifest.json') {
      const manifest = JSON.parse(data.toString('utf8')) as {manifest_version?:unknown;name?:unknown};
      if (manifest.manifest_version !== 3 || manifest.name !== 'StudentBuddy 网页共读') throw new Error('网页共读扩展清单无效');
    }
    const filename = Buffer.from(name), crc = zipCrc32(data), header = Buffer.alloc(30), index = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(0x21,12);
    header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(filename.length,26);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20,4); index.writeUInt16LE(20,6); index.writeUInt16LE(0x800,8); index.writeUInt16LE(0x21,14);
    index.writeUInt32LE(crc,16); index.writeUInt32LE(data.length,20); index.writeUInt32LE(data.length,24); index.writeUInt16LE(filename.length,28); index.writeUInt32LE(offset,42);
    records.push(header,filename,data); central.push(index,filename); offset += header.length+filename.length+data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(READER_EXTENSION_FILES.length,8); end.writeUInt16LE(READER_EXTENSION_FILES.length,10); end.writeUInt32LE(index.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...records,index,end]);
}
