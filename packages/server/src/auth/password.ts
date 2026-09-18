/**
 * auth/password — 口令派生与校验（**scrypt，Node 内置，零新依赖**；契约 docs/AUTH-SPEC.md §4.1）。
 *
 * ★ 为什么是 scrypt 而不是 bcrypt/argon2：本仓偏好零依赖（ADR-2 简洁优先），且
 *   `better-sqlite3` 已是唯一的原生模块，不再加第二个。`node:crypto` 的 scrypt 是标准 KDF，
 *   内存硬化（memory-hard）足以抵抗离线爆破，够用。
 *
 * ★ 落库格式：`scrypt$N$r$p$<saltB64>$<hashB64>`——**参数随哈希一起存**。这样将来调参
 *   （如把 N 从 2^14 提到 2^15）只需改 `CURRENT_PARAMS`，老哈希仍按自己那行参数校验，
 *   无需一次性洗库（这正是「自描述哈希」的意义）。
 *
 * ★ 校验一律 `timingSafeEqual`（定长比较，防时序侧信道）；解析失败/参数缺失一律回 `false`，
 *   **绝不抛**——一个脏哈希不该让登录端点 500。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** 当前派生参数。N=16384（2^14）、r=8、p=1 是 Node 文档常用档，单次约 50~100ms。 */
const CURRENT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;
/** 派生密钥长度（字节）。 */
const KEYLEN = 64;
/** 盐长度（字节）：16 字节随机，足够避免彩虹表与盐碰撞。 */
const SALT_BYTES = 16;
/**
 * scrypt 内存上限。公式 `128 * N * r` = 128×16384×8 = 16MiB；给 64MiB 留足余量，
 * 且**必须显式传**——不传时 Node 用默认 32MiB，将来把 N 调大就会撞 `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`。
 */
const MAXMEM = 64 * 1024 * 1024;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** 回调式 scrypt 包成 Promise（不用 promisify：其重载签名会引入宽松类型）。 */
function derive(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/** 生成口令哈希（注册时调用）。每次调用都用**新盐** ⇒ 同一口令两次结果不同。 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = CURRENT_PARAMS;
  const key = await derive(plain, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 解析自描述哈希串；任何不合规（段数/算法/数值）返回 `null`。 */
function parseStored(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 1 || r <= 0 || p <= 0) return null;
  let salt: Buffer;
  let hash: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    hash = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return null;
  }
  if (salt.length === 0 || hash.length === 0) return null;
  return { params: { N, r, p }, salt, hash };
}

/**
 * 校验口令。**任何异常/不合规都回 `false`**（脏哈希不该把登录端点打成 500）。
 * 长度不等时也先 `timingSafeEqual` 前比较长度，长度不同直接 false（长度本身不是秘密）。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  let key: Buffer;
  try {
    key = await derive(plain, parsed.salt, parsed.hash.length, parsed.params);
  } catch {
    return false;
  }
  if (key.length !== parsed.hash.length) return false;
  return timingSafeEqual(key, parsed.hash);
}
