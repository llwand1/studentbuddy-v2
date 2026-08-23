/**
 * storage/crypto — 密钥加密（AES-256-GCM + Windows DPAPI 主密钥保护）。
 * port from v1: src/core/security/crypto.ts（审查搬运：幂等前缀/明文兼容/DPAPI 降级策略原样保留）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR } from './db.js';

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
let masterKey: Buffer | null = null;

const mkPath = () => path.join(DATA_DIR, '.mk');

export function initCrypto(): void {
  try {
    const mk = mkPath();
    if (fs.existsSync(mk)) {
      const wrapped = fs.readFileSync(mk);
      // 旧明文主密钥（32 字节）迁移：复用旧钥并立即 DPAPI 重包装（v1 行为保留）
      if (process.platform === 'win32' && wrapped.length === 32) {
        const wrappedDp = dpapiProtect(wrapped);
        if (wrappedDp) fs.writeFileSync(mk, wrappedDp, { mode: 0o600 });
        masterKey = wrapped;
        return;
      }
      const unwrapped = dpapiUnprotect(wrapped);
      if (unwrapped && unwrapped.length === 32) {
        masterKey = unwrapped;
        return;
      }
    }
    masterKey = crypto.randomBytes(32);
    const wrapped = dpapiProtect(masterKey);
    if (wrapped) {
      fs.mkdirSync(path.dirname(mk), { recursive: true });
      fs.writeFileSync(mk, wrapped, { mode: 0o600 });
    } else if (process.platform !== 'win32') {
      // 非 Windows 如实降级：随机机器密钥明文落盘（无用户绑定）
      fs.mkdirSync(path.dirname(mk), { recursive: true });
      fs.writeFileSync(mk, masterKey, { mode: 0o600 });
    } else {
      // Windows DPAPI 失败：主密钥仅存内存（宁缺毋滥，不退回明文）
      console.warn('[crypto] DPAPI 不可用，主密钥仅存内存（重启后旧密文不可解密）');
    }
  } catch (err) {
    console.error('[crypto] initCrypto failed:', err instanceof Error ? err.message : err);
    masterKey = crypto.randomBytes(32);
  }
}

function key(): Buffer {
  if (!masterKey) initCrypto();
  return masterKey!;
}

/** 加密：返回 `enc:v1:<base64(iv|tag|ct)>`；空串/已加密幂等返回。 */
export function encryptSecret(plain: string): string {
  if (!plain || plain.startsWith(PREFIX)) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** 解密：不带前缀视为旧明文直接返回（兼容迁移）。 */
export function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const blob = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv(ALGO, key(), blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    return d.update(blob.subarray(28), undefined, 'utf8') + d.final('utf8');
  } catch (err) {
    console.error('[crypto] decryptSecret failed:', err instanceof Error ? err.message : err);
    return '';
  }
}

export function isEncrypted(stored: string): boolean {
  return !!stored && stored.startsWith(PREFIX);
}

// ── Windows DPAPI（PowerShell 托管 ProtectedData，CurrentUser 作用域）──
const DPAPI_SCOPE = '[System.Security.Cryptography.DataProtectionScope]::CurrentUser';

function runDpapi(inputB64: string, protect: boolean): string | null {
  try {
    const verb = protect ? 'Protect' : 'Unprotect';
    const script = [
      "$ProgressPreference='SilentlyContinue'",
      'Add-Type -AssemblyName System.Security',
      `$b=[System.Convert]::FromBase64String('${inputB64}')`,
      `$e=[System.Security.Cryptography.ProtectedData]::${verb}($b,$null,${DPAPI_SCOPE})`,
      '[System.Convert]::ToBase64String($e)',
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = (
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        timeout: 20000,
        encoding: 'utf8',
      }) || ''
    ).trim();
    if (!out || out.startsWith('<Objs') || out.startsWith('#< CLIXML')) return null;
    return out;
  } catch {
    return null;
  }
}

function dpapiProtect(mk: Buffer): Buffer | null {
  if (process.platform !== 'win32') return null;
  const b64 = runDpapi(mk.toString('base64'), true);
  return b64 ? Buffer.from(b64, 'base64') : null;
}

function dpapiUnprotect(wrapped: Buffer): Buffer | null {
  if (process.platform !== 'win32') return wrapped;
  const b64 = runDpapi(wrapped.toString('base64'), false);
  return b64 ? Buffer.from(b64, 'base64') : null;
}
