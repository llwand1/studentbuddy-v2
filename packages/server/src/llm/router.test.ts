/**
 * llm/router 单测 —— M2c **归属**（契约 `docs/TENANCY-SPEC.md` §8.1）。
 *
 * ★ 本文件存在的理由：`routeRole` 在本批之前**只被别的测试 mock 掉**（compact / flow / vision /
 *   quiz-weak / quiz / terms / coach / pk-pve 八个文件全是 `vi.mock('../llm/router.js')`），
 *   于是 M2c 最核心的那句承诺——「**用户 A 配的 key 不会被 B 的对话烧掉**」——**一条断言都没有**。
 *   本文件用真库（`openIsolated`）+ 真 `routeRole` 把这条钉住。
 *
 * ★ 密钥刻意用**明文**（非 `enc:v1:` 前缀）：`decryptSecret` 对无前缀值原样返回（旧库兼容路径），
 *   这样断言可以精确到「拿到的就是 A 那把 key / 不是 A 那把 key」，不必绕加密往返。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { MODEL_ROLES, getProviders, roleReady, routeRole, seedIfEmpty } from './router.js';

let dir: string;

/** 种子平台 provider（`openai-default`）的 baseUrl —— `seedIfEmpty()` 里写死的那个值。 */
const PLATFORM_BASE = 'https://api.openai.com/v1';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-router-'));
  openIsolated(dir);
  seedIfEmpty(); // 平台 provider（openai-default，owner_id = NULL）+ 各角色的平台绑定
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 塞一个 provider。`owner === null` ⇒ 平台通道（老板出的钱）。 */
function addProvider(id: string, owner: string | null, apiKey: string, enabled = 1): void {
  getDb()
    .prepare(
      `INSERT INTO providers (id, name, base_url, api_key, type, enabled, owner_id)
       VALUES (?, ?, ?, ?, 'openai', ?, ?)`,
    )
    .run(id, id, `https://${id}.example/v1`, apiKey, enabled, owner);
}

/** 塞一条角色绑定。**刻意直写库**——用来模拟"绕过路由校验"的越权绑定。 */
function bind(role: string, providerId: string, model: string, owner: string | null): void {
  getDb()
    .prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (?, ?, ?, ?)`)
    .run(owner, role, providerId, model);
}

const platformBindingCount = (): number =>
  (getDb().prepare(`SELECT COUNT(*) AS c FROM role_bindings WHERE owner_id IS NULL`).get() as { c: number }).c;

describe('llm/router — M2c 归属：谁付模型钱', () => {
  it('本地单人模式（省略 ownerId / 传 null）走平台通道，与加归属之前的行为一致', () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET');
    bind('explain', 'p-a', 'a-model', 'uA');
    // 未登录 ⇒ 不做归属判定，只用平台绑定（老库升级后既有绑定回填的就是 NULL）
    for (const t of [routeRole('explain'), routeRole('explain', undefined, null)]) {
      expect(t?.baseUrl).toBe(PLATFORM_BASE);
      expect(t?.apiKey).toBe('');
      expect(t?.apiKey).not.toBe('sk-A-SECRET'); // ★ 单人模式也不许串到某个用户的 key
    }
  });

  it('★ A 的 key 不会被 B 烧掉：各自拿各自的 provider', () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET');
    addProvider('p-b', 'uB', 'sk-B-SECRET');
    bind('explain', 'p-a', 'a-model', 'uA');
    bind('explain', 'p-b', 'b-model', 'uB');

    const a = routeRole('explain', undefined, 'uA');
    const b = routeRole('explain', undefined, 'uB');
    expect(a?.apiKey).toBe('sk-A-SECRET');
    expect(a?.model).toBe('a-model');
    expect(b?.apiKey).toBe('sk-B-SECRET');
    expect(b?.model).toBe('b-model');
  });

  it('★ 没自带 key 的用户走免费通道（平台 provider），而不是"借"别人的', () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET');
    bind('explain', 'p-a', 'a-model', 'uA');

    const b = routeRole('explain', undefined, 'uB'); // uB 什么都没配
    expect(b?.apiKey).toBe(''); // 平台 key（种子里是空串）
    expect(b?.apiKey).not.toBe('sk-A-SECRET');
    expect(b?.baseUrl).toBe(PLATFORM_BASE);
  });

  it('★ 越权绑定（直写库把自己的绑定指向别人的 provider）也取不到别人的 key', () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET');
    // 绕过 `PUT /roles/:role` 的可见性校验，硬写一条指向 A 的绑定
    bind('explain', 'p-a', 'a-model', 'uB');
    const b = routeRole('explain', undefined, 'uB');
    // 归属断言在 `providerById`（`owner_id IS NULL OR owner_id IS ?`）⇒ 取不到，整条回落平台绑定
    expect(b?.apiKey).not.toBe('sk-A-SECRET');
    expect(b?.baseUrl).toBe(PLATFORM_BASE);
  });

  it('用户可以把角色绑到**平台** provider 上换模型（免费通道要可调，否则成摆设）', () => {
    bind('summarizer', 'openai-default', 'cheap-model', 'uA');
    const t = routeRole('summarizer', undefined, 'uA');
    expect(t?.baseUrl).toBe(PLATFORM_BASE);
    expect(t?.model).toBe('cheap-model'); // 平台 provider + 我自己选的模型
  });

  it('自己的 provider 被停用 ⇒ 整条回落平台绑定（不是"拿我的 model 配平台 provider"）', () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET', 0); // enabled = 0
    bind('explain', 'p-a', 'a-model', 'uA');
    const t = routeRole('explain', undefined, 'uA');
    // 两者的服务商不同、模型名大概率不存在 ⇒ 必须整条链一起换，才是能跑通的降级
    expect(t?.apiKey).toBe('');
    expect(t?.baseUrl).toBe(PLATFORM_BASE);
  });

  it('平台绑定全没时，兜底只取**平台** provider——绝不取别人的', () => {
    getDb().prepare(`DELETE FROM role_bindings WHERE owner_id IS NULL`).run();
    addProvider('p-a', 'uA', 'sk-A-SECRET'); // 平台 provider 已被停用
    getDb().prepare(`UPDATE providers SET enabled = 0 WHERE owner_id IS NULL`).run();

    // uB 什么都没配：宁可返回 null 让上层报「没有可用的服务商」，也不能静默花 A 的钱
    expect(routeRole('explain', undefined, 'uB')).toBeNull();
    expect(roleReady('explain', 'uB').ok).toBe(false);
  });
});

describe('llm/router — getProviders 可见性（平台可见、别人的不可见）', () => {
  it('自己的 + 平台的；★ 别人的 provider 不出现在列表里', () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET');
    addProvider('p-b', 'uB', 'sk-B-SECRET');

    const ids = (owner: string | null): string[] => getProviders(owner).map((p) => p.id).sort();
    expect(ids('uA')).toEqual(['openai-default', 'p-a']);
    expect(ids('uB')).toEqual(['openai-default', 'p-b']);
    // 未登录（本地单人模式）只看平台行
    expect(ids(null)).toEqual(['openai-default']);
  });

  it('出站字段带 ownerId，且**绝不含 apiKey 明文**', () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET');
    const rows = getProviders('uA');
    const mine = rows.find((p) => p.id === 'p-a');
    const platform = rows.find((p) => p.id === 'openai-default');
    expect(mine?.ownerId).toBe('uA');
    expect(platform?.ownerId).toBeNull();
    // 序列化后也不能漏 key（前端据此区分"可改"与"只读"，不需要 key）
    expect(JSON.stringify(rows)).not.toContain('sk-A-SECRET');
  });
});

describe('llm/router — seedIfEmpty 幂等（v29 部分唯一索引的回归锁）', () => {
  it('★ 重复种子不会把平台绑定插成多条（复合 PK 对 NULL 无效，靠 idx_role_bindings_platform）', () => {
    expect(platformBindingCount()).toBe(MODEL_ROLES.length);

    // 只删 provider 行、留下绑定 ⇒ 再调 seedIfEmpty 会真的走插入分支
    getDb().prepare(`DELETE FROM providers`).run();
    seedIfEmpty();
    seedIfEmpty();

    expect(platformBindingCount()).toBe(MODEL_ROLES.length); // 没多、没少
    // 且平台 provider 也回来了（owner_id 仍是 NULL = 平台通道）
    const seed = getDb().prepare(`SELECT owner_id FROM providers WHERE id = 'openai-default'`).get() as
      | { owner_id: string | null }
      | undefined;
    expect(seed?.owner_id).toBeNull();
  });
});
