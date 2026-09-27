/**
 * auth/password 单元测试（纯 crypto，零 DB）：自描述哈希格式 / 新盐 / 校验 / 脏哈希不抛 / 老参数可校验。
 *
 * ★ 为什么单列一条「老参数哈希仍能校验」：这正是 `scrypt$N$r$p$salt$hash` **把参数随哈希一起存**
 *   的意义。若实现改成用 `CURRENT_PARAMS` 去校验所有行，调参那天全站老用户会被静默锁在门外，
 *   且**没有任何测试会红**（因为新库的哈希参数恒等于 CURRENT_PARAMS）。此用例就是那条防线。
 */
import { describe, it, expect } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';

describe('auth/password — 哈希格式（自描述）', () => {
  it('形如 scrypt$N$r$p$saltB64$hashB64（6 段，参数随哈希落库）', async () => {
    const stored = await hashPassword('correct horse battery');
    const parts = stored.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBeGreaterThan(1); // N
    expect(Number(parts[2])).toBeGreaterThan(0); // r
    expect(Number(parts[3])).toBeGreaterThan(0); // p
    expect(parts[4]!.length).toBeGreaterThan(0); // 盐
    expect(parts[5]!.length).toBeGreaterThan(0); // 摘要
  });

  it('同一口令两次哈希不同（每次新盐 ⇒ 库内看不到「同口令同哈希」的彩虹表入口）', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');
    expect(a).not.toBe(b);
    // 但两者都能校验通过
    expect(await verifyPassword('same-password-123', a)).toBe(true);
    expect(await verifyPassword('same-password-123', b)).toBe(true);
  });
});

describe('auth/password — 校验', () => {
  it('正确口令 → true；错误口令 → false', async () => {
    const stored = await hashPassword('my-secret-pw');
    expect(await verifyPassword('my-secret-pw', stored)).toBe(true);
    expect(await verifyPassword('my-secret-PW', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('UTF-8 口令（中文 / emoji）可正常往返', async () => {
    const pw = '学习使我快乐🔒';
    const stored = await hashPassword(pw);
    expect(await verifyPassword(pw, stored)).toBe(true);
    expect(await verifyPassword('学习使我快乐', stored)).toBe(false);
  });

  it('脏哈希一律回 false，**绝不抛**（一个脏行不该把登录端点打成 500）', async () => {
    const dirty = [
      '',
      'not-a-hash',
      'scrypt$16384$8$1$onlyfivefields',
      'bcrypt$16384$8$1$c2FsdA==$aGFzaA==', // 算法名不对
      'scrypt$abc$8$1$c2FsdA==$aGFzaA==', // N 非整数
      'scrypt$1$8$1$c2FsdA==$aGFzaA==', // N <= 1
      'scrypt$16384$0$1$c2FsdA==$aGFzaA==', // r <= 0
      'scrypt$16384$8$1$$aGFzaA==', // 空盐
      'scrypt$16384$8$1$c2FsdA==$', // 空摘要
    ];
    for (const stored of dirty) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    }
  });
});

describe('auth/password — 参数自描述的意义（将来调参不洗库）', () => {
  it('用**更弱的旧参数**（N=1024）生成的哈希仍能校验通过', async () => {
    // 手工造一条「老参数」哈希，模拟改动 CURRENT_PARAMS 之前落库的行
    const salt = randomBytes(16);
    const key = scryptSync('legacy-password', salt, 64, { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const legacy = `scrypt$1024$8$1$${salt.toString('base64')}$${key.toString('base64')}`;

    expect(await verifyPassword('legacy-password', legacy)).toBe(true);
    expect(await verifyPassword('wrong-password', legacy)).toBe(false);
  });
});
