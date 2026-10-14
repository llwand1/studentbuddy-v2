import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DesktopFileEntry, DesktopFileText } from '@sb/shared';
import { DATA_DIR } from '../storage/db.js';
import { readTarget, writeTarget, sensitivityReason, sensitiveText } from './file-policy.js';
import { askFileApproval, type FileContext } from './file-approvals.js';
export const FILE_LIMIT = 256 * 1024;
function samePath(a: string, b: string): boolean { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function snapshot(file: string): { text: string; bytes: number; truncated: boolean } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('只能读取普通文件');
    const buffer = Buffer.alloc(Math.min(stat.size, FILE_LIMIT));
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0), data = buffer.subarray(0, bytes);
    if (data.includes(0)) throw new Error('这是二进制文件；当前文件工具只提取文本，不执行或解析程序。');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { text = new TextDecoder('gb18030', { fatal: true }).decode(data); }
    // Verify that the opened inode still belongs to the requested canonical file.
    const current = fs.statSync(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('文件在读取时被替换，请重试');
    return { text, bytes: stat.size, truncated: stat.size > FILE_LIMIT };
  } finally { fs.closeSync(fd); }
}
export async function listComputerFiles(ctx: FileContext, input: string): Promise<DesktopFileEntry[]> {
  ctx.signal?.throwIfAborted(); const file = readTarget(ctx.owner, input), reason = sensitivityReason(ctx.owner, file);
  if (reason) await askFileApproval(ctx, file, 'list', reason);
  ctx.signal?.throwIfAborted();
  if (!samePath(readTarget(ctx.owner, input), file)) throw new Error('目录指向已改变，请重试');
  return fs.readdirSync(file, { withFileTypes: true }).slice(0, 200).map(e => ({ name: e.name, path: path.join(file, e.name), directory: e.isDirectory(), sensitive: !!sensitivityReason(ctx.owner, path.join(file, e.name)) }));
}
export async function readComputerFile(ctx: FileContext, input: string): Promise<DesktopFileText> {
  ctx.signal?.throwIfAborted(); const file = readTarget(ctx.owner, input), pathReason = sensitivityReason(ctx.owner, file);
  if (pathReason) await askFileApproval(ctx, file, 'read', pathReason);
  ctx.signal?.throwIfAborted();
  let data = snapshot(file);
  const contentReason = !pathReason && sensitiveText(data.text);
  if (contentReason) { await askFileApproval(ctx, file, 'read', contentReason); ctx.signal?.throwIfAborted(); data = snapshot(file); }
  if (!samePath(readTarget(ctx.owner, input), file)) throw new Error('文件指向已改变，请重试');
  return { path: file, ...data };
}
export async function writeWorkspaceFile(ctx: FileContext, input: string, text: string): Promise<{ path: string; bytes: number; backup: boolean }> {
  if (ctx.writeAllowed === false) throw new Error('该子 Agent 继承只读权限，不能写文件');
  ctx.signal?.throwIfAborted();
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > FILE_LIMIT) throw new Error('单次写入文本不能超过 256KB');
  const target = writeTarget(ctx.owner, input), reason = sensitivityReason(ctx.owner, target) || sensitiveText(text);
  if (reason) await askFileApproval(ctx, target, 'write', reason);
  ctx.signal?.throwIfAborted();
  if (!samePath(writeTarget(ctx.owner, input), target)) throw new Error('工作区已改变，请重新规划写入');
  if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error('不能覆盖目录');
  if (fs.existsSync(target) && fs.statSync(target).size > FILE_LIMIT) throw new Error('已有文件超过 256KB，请另存新文件，避免截断覆盖原件');
  // Backup only after approval, including non-sensitive paths whose existing content is sensitive.
  if (fs.existsSync(target) && !reason) {
    const existing = snapshot(target), existingReason = sensitiveText(existing.text);
    if (existingReason) await askFileApproval(ctx, target, 'write', '将覆盖包含敏感内容的文件');
  }
  ctx.signal?.throwIfAborted();
  if (!samePath(writeTarget(ctx.owner, input), target)) throw new Error('写入路径已改变');
  fs.mkdirSync(path.dirname(target), { recursive: true }); writeTarget(ctx.owner, input);
  const backup = fs.existsSync(target);
  if (backup) { const dir = path.join(DATA_DIR, 'file-backups'); fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(target, path.join(dir, `${Date.now()}-${randomUUID()}-${path.basename(target)}`)); }
  const temporary = path.join(path.dirname(target), `.sb-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' });
    ctx.signal?.throwIfAborted(); writeTarget(ctx.owner, input); fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { path: target, bytes: Buffer.byteLength(text, 'utf8'), backup };
}
