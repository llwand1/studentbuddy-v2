import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import type { DesktopWorkspaceInfo } from '@sb/shared';

export function desktopEnabled(): boolean {
  return process.env.SB_DESKTOP === '1' && ['127.0.0.1', '::1'].includes(process.env.SB_HOST ?? '127.0.0.1');
}
export function requireDesktop(): void { if (!desktopEnabled()) throw new Error('文件与子 Agent 仅在本机安装版可用'); }
/** Known-folder metadata does not enumerate or read any files. Native paths honor redirection. */
export function desktopLocations(): { desktop: string; documents: string; downloads: string } {
  return { desktop: process.env.SB_DESKTOP_USER_DESKTOP ?? path.join(os.homedir(), 'Desktop'),
    documents: process.env.SB_DESKTOP_USER_DOCUMENTS ?? path.join(os.homedir(), 'Documents'),
    downloads: path.join(os.homedir(), 'Downloads') };
}
export function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export function sensitivePath(value: string): string {
  const parts = value.replaceAll('\\', '/').toLowerCase().split('/');
  if (parts.some(p => ['.ssh','.aws','.azure','.gnupg','.kube','.codex','.workbuddy','appdata','keychains','wallets','credentials'].includes(p))) return '账号、应用配置或凭据目录';
  const base = parts.at(-1) ?? '';
  if (/^\.env($|\.)|^id_(rsa|ed25519|ecdsa)|(^|[._ -])(secret|secrets|credentials?|passwords?|tokens?|private[-_]?key|密钥|密码|凭据|财务|身份证)([._ -]|$)/i.test(base)) return '文件名可能包含私密资料';
  if (/\.(pem|key|pfx|p12|kdbx|keystore|wallet|db|sqlite|sqlite3)$/i.test(base)) return '密钥、密码库或数据库文件';
  return '';
}
export function sensitiveText(value: string): string {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|password|secret|authorization|密码|密钥)\s*[=:]\s*["']?[^\s"']{4,}/i.test(value)) return '正文检测到凭据或密钥特征';
  if (/\b\d{17}[\dXx]\b|(?:银行卡|账户号码|信用卡|身份证号)\s*[:：]?\s*\d{8,}/.test(value)) return '正文检测到身份或财务资料特征';
  return '';
}
function setting(owner: string | null): string | undefined {
  return (getDb().prepare('SELECT value FROM app_settings WHERE owner_id=? AND key=?')
    .get(ownerForWrite(owner), 'desktop.files.workspace') as { value: string } | undefined)?.value;
}
export function protectedPaths(owner: string | null): string[] {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE owner_id=? AND key=?')
    .get(ownerForWrite(owner), 'desktop.files.protected') as { value: string } | undefined;
  try { const value: unknown = JSON.parse(row?.value ?? '[]'); return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string').slice(0, 100) : []; } catch { return []; }
}
export function sensitivityReason(owner: string | null, target: string): string {
  return protectedPaths(owner).some(root => within(root, target)) ? '用户标记的敏感文件或目录' : sensitivePath(target);
}
export function protectPath(owner: string | null, input: string, protect: boolean): void {
  requireDesktop();
  const file = readTarget(owner, input), current = protectedPaths(owner).filter(p => p !== file);
  if (protect) current.push(file);
  if (current.length > 100) throw new Error('最多标记 100 个敏感位置');
  getDb().prepare('INSERT INTO app_settings(owner_id,key,value) VALUES(?,?,?) ON CONFLICT(owner_id,key) DO UPDATE SET value=excluded.value')
    .run(ownerForWrite(owner), 'desktop.files.protected', JSON.stringify(current));
}
export function workspaceInfo(owner: string | null): DesktopWorkspaceInfo {
  requireDesktop();
  const chosen = setting(owner), root = chosen ?? process.env.SB_DESKTOP_WORKSPACE_ROOT ?? path.join(os.homedir(), 'Documents', 'StudentBuddy Workspace');
  if (!chosen) fs.mkdirSync(root, { recursive: true });
  const real = fs.realpathSync(root);
  if (!fs.statSync(real).isDirectory()) throw new Error('工作区目录不存在');
  return { root: real, locations: desktopLocations(), protectedPaths: protectedPaths(owner), computerAccess: 'read_only', workspaceAccess: 'read_write', sensitiveAccess: 'ask_once' };
}
export function chooseWorkspace(owner: string | null, input: string): DesktopWorkspaceInfo {
  requireDesktop(); checkPathSyntax(input, true);
  const root = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(root).isDirectory() || root === path.parse(root).root || root.toLowerCase() === os.homedir().toLowerCase() || sensitivePath(root) || /[\\/](windows|program files(?: \(x86\))?)([\\/]|$)/i.test(root)) throw new Error('请选择独立的普通文件夹，不能使用整盘、整个用户目录或敏感/系统目录');
  getDb().prepare('INSERT INTO app_settings(owner_id,key,value) VALUES(?,?,?) ON CONFLICT(owner_id,key) DO UPDATE SET value=excluded.value')
    .run(ownerForWrite(owner), 'desktop.files.workspace', root);
  return workspaceInfo(owner);
}
export function checkPathSyntax(input: string, absolute = false): void {
  if (!input || input.length > 2048 || /[\0\r\n]/.test(input) || /^(\\\\|\/\/)/.test(input) || /^[A-Za-z]:[^\\/]/.test(input)) throw new Error('路径无效；不支持网络、设备或盘符相对路径');
  if (input.replace(/^[A-Za-z]:/, '').includes(':')) throw new Error('不支持备用数据流路径');
  if (absolute && !path.isAbsolute(input)) throw new Error('请选择绝对目录路径');
  if (!path.isAbsolute(input) && input.split(/[\\/]/).includes('..')) throw new Error('相对路径不能离开工作区；区外只读需给出绝对路径');
  if (input.split(/[\\/]/).some(p => p !== '.' && p !== '..' && /[. ]$/.test(p))) throw new Error('路径段不能使用尾随空格或点的 Windows 别名');
  if (input.split(/[\\/]/).some(p => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('不支持设备名称');
}
export function readTarget(owner: string | null, input: string): string {
  requireDesktop(); checkPathSyntax(input);
  const root = workspaceInfo(owner).root;
  return fs.realpathSync(path.resolve(root, input));
}
/** For writes, reject all existing symlink/junction components before side effects. */
export function writeTarget(owner: string | null, input: string): string {
  requireDesktop(); checkPathSyntax(input);
  const root = workspaceInfo(owner).root, target = path.resolve(root, input);
  if (!within(root, target) || target === root) throw new Error('工作区外只有只读权，不能写入');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !within(root, fs.realpathSync(current))) throw new Error('写入路径不能经过符号链接或目录联接');
  }
  return target;
}
