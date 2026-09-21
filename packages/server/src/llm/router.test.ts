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
import { acquireUpstream, resetUpstreamGates, upstreamStats } from './upstream-gate.js';

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

describe('llm/router — M2c 配额归属（契约 §8.1.3.1：内层按**请求者**分桶）', () => {
  /** 冲掉微任务队列：闸门的放行/拒绝都经 Promise，断言前要给它跑完的机会 */
  async function tick(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('BYOK 分支：配额 = 本人 + `platform:false`（平台不付钱 ⇒ 不受全站封顶约束）', () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET');
    bind('explain', 'p-a', 'a-model', 'uA');
    const t = routeRole('explain', undefined, 'uA')!;
    expect(t.baseUrl).toBe('https://p-a.example/v1');
    expect(t.quota).toEqual({ ownerId: 'uA', platform: false });
  });

  it('★ 平台绑定分支：provider 的 owner 是 NULL，但**配额里的 ownerId 必须是请求者**', () => {
    // 没绑自己的 ⇒ 落平台绑定（provider 行 owner_id = NULL）
    const t = routeRole('explain', undefined, 'uA')!;
    expect(t.baseUrl).toBe(PLATFORM_BASE);
    // ★ 这里若图省事写 `null`，所有免费用户会挤进同一个内层桶（"加 owner 维度"就白加了）
    expect(t.quota).toEqual({ ownerId: 'uA', platform: true });
  });

  it('平台兜底分支（平台绑定被删）同样记请求者；未登录记 `null`', () => {
    getDb().prepare(`DELETE FROM role_bindings WHERE owner_id IS NULL`).run();
    expect(routeRole('explain', undefined, 'uA')!.quota).toEqual({ ownerId: 'uA', platform: true });
    expect(routeRole('explain')!.quota).toEqual({ ownerId: null, platform: true });
  });

  it('★ 配额真的绑在 adapter 上：占满该请求者的内层桶后，chat() 会排进**他**的桶', async () => {
    addProvider('p-a', 'uA', 'sk-A-SECRET');
    bind('explain', 'p-a', 'a-model', 'uA');
    const t = routeRole('explain', undefined, 'uA')!;

    // 上游打桩成"立刻失败"：本用例只关心**闸门落在哪个桶**，不关心请求本身（也不打真网络）
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('no-network'))) as typeof fetch;
    resetUpstreamGates();
    const held = [
      await acquireUpstream(t.baseUrl, 'main', undefined, { ownerId: 'uA', platform: false }),
      await acquireUpstream(t.baseUrl, 'main', undefined, { ownerId: 'uA', platform: false }),
    ];
    try {
      const gen = t.adapter.chat({
        model: t.model,
        apiKey: t.apiKey,
        baseUrl: t.baseUrl,
        messages: [],
      })[Symbol.asyncIterator]();
      const pending = gen.next();
      await tick();
      // ★ 若配额没绑上（`ChatRequest.quota` 缺省 = 未登录**平台**通道），它会落进
      //   `(baseUrl, null)` 桶并**被放行**（于是直接去 fetch）⇒ 下面两条都会红
      expect(upstreamStats(t.baseUrl, 'uA').pendingMain).toBe(1);
      expect(upstreamStats(t.baseUrl, null).pendingMain).toBe(0);

      held.forEach((r) => r());
      await pending.catch(() => undefined); // 放行后真的去 fetch，被上面的桩拒掉
    } finally {
      globalThis.fetch = realFetch;
      resetUpstreamGates();
    }
  });
});

// ── v39（2026-09-21）：零配置平台通道 —— 凭据从 env 注入 ──────────────────────
// 老板原话：「api 哪里就改成默认零配置 …… 直接使用我的 key 的额度，但是**不让用户看到**」。
// 手法：平台行的 key/baseUrl 优先从 `SB_PLATFORM_*` 读 ⇒ **数据库里那把 key 永远是空的**，
// 任何拖库 / 接口泄漏都拿不到它（`getProviders` 本来也不返回 api_key）。
// ★ 这几条用例都要动 env，故逐条存还原 —— 漏还原会污染同文件后面的用例（vitest 同文件共享进程）。

describe('llm/router — v39 零配置：平台凭据走 env，且**只对平台通道**生效', () => {
  const ENV_KEYS = ['SB_PLATFORM_API_KEY', 'SB_PLATFORM_BASE_URL', 'SB_PLATFORM_MODEL'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** 把种子平台行改造成"库里有真凭据"，用来验证 env 缺省时的回落。 */
  function seedPlatformCreds(apiKey: string, baseUrl: string): void {
    getDb()
      .prepare(`UPDATE providers SET api_key = ?, base_url = ? WHERE id = 'openai-default'`)
      .run(apiKey, baseUrl);
  }

  it('★ 零配置开箱：库里的 key 与 model 都空 —— 配上 env 立刻可用（线上 09-21 卡的就是这条）', () => {
    // 种子原样 = 平台 provider `api_key = ''` + 各角色 `model = ''`，即线上真实状态
    const before = roleReady('explain', 'uNew');
    expect(before.ok).toBe(false);
    expect(before.reason).toBe('该角色还没绑定模型');

    process.env.SB_PLATFORM_API_KEY = 'sk-platform-ENV';
    process.env.SB_PLATFORM_BASE_URL = 'https://relay.example/v1';
    process.env.SB_PLATFORM_MODEL = 'gpt-4o-mini';

    const t = routeRole('explain', undefined, 'uNew')!;
    expect(t.apiKey).toBe('sk-platform-ENV');
    expect(t.baseUrl).toBe('https://relay.example/v1');
    expect(t.model).toBe('gpt-4o-mini');
    expect(roleReady('explain', 'uNew').ok).toBe(true);
  });

  it('★ env 里的平台 key 不会从 /providers 漏出去（"不让用户看到"）', () => {
    process.env.SB_PLATFORM_API_KEY = 'sk-platform-ENV';
    expect(JSON.stringify(getProviders('uA'))).not.toContain('sk-platform-ENV');
    expect(JSON.stringify(getProviders(null))).not.toContain('sk-platform-ENV');
  });

  it('★ 只对平台通道注入：BYOK 用户自己的 key/地址/模型**一个都不许被顶掉**', () => {
    addProvider('p-a', 'uA', 'sk-A-OWN');
    bind('explain', 'p-a', 'a-model', 'uA');
    process.env.SB_PLATFORM_API_KEY = 'sk-platform-ENV';
    process.env.SB_PLATFORM_BASE_URL = 'https://relay.example/v1';
    process.env.SB_PLATFORM_MODEL = 'env-model';

    const t = routeRole('explain', undefined, 'uA')!;
    // 顶掉就是"你配了自己的 key，花的却是平台的钱"——比不生效更糟
    expect(t.apiKey).toBe('sk-A-OWN');
    expect(t.baseUrl).toBe('https://p-a.example/v1');
    expect(t.model).toBe('a-model');
  });

  it('★ 优先级：绑定表里的 model 胜过 env（设置页改的才是"这台部署要用的"）', () => {
    process.env.SB_PLATFORM_MODEL = 'env-model';
    bind('summarizer', 'openai-default', 'picked-model', 'uA');
    expect(routeRole('summarizer', undefined, 'uA')!.model).toBe('picked-model');
    expect(routeRole('explain', undefined, 'uA')!.model).toBe('env-model'); // 没绑的才吃 env
  });

  it('env 未配时逐条回落数据库（老部署与 BYOK 自建 provider 行为不变）', () => {
    seedPlatformCreds('sk-platform-DB', 'https://db.example/v1');
    const t = routeRole('explain', undefined, 'uA')!;
    expect(t.apiKey).toBe('sk-platform-DB');
    expect(t.baseUrl).toBe('https://db.example/v1');

    // 只配一条 ⇒ 另外两条各自回落，不是"配了一条就全用 env"
    process.env.SB_PLATFORM_MODEL = 'env-model';
    const t2 = routeRole('explain', undefined, 'uA')!;
    expect(t2.apiKey).toBe('sk-platform-DB');
    expect(t2.baseUrl).toBe('https://db.example/v1');
    expect(t2.model).toBe('env-model');
  });

  it('空串 env 视同未配（不是"把 key 设成空串"）', () => {
    seedPlatformCreds('sk-platform-DB', 'https://db.example/v1');
    process.env.SB_PLATFORM_API_KEY = '';
    process.env.SB_PLATFORM_BASE_URL = '   '; // 空白也要当未配（运维手滑留空格）
    const t = routeRole('explain', undefined, 'uA')!;
    expect(t.apiKey).toBe('sk-platform-DB');
    expect(t.baseUrl).toBe('https://db.example/v1');
  });

  it('★ 回归锁：平台绑定的 provider 被停用 ⇒ 走默认兜底路径，**绑定表里的 model 不许丢**', () => {
    // v39 自查抓到的真回归：默认分支曾写成 `platformEnvModel() || fallbackModel`，
    // 把 `platform?.model` 丢了。本路径**可达** —— 上面的 ② 在 provider 被停用/删除时返回
    // null 会落到这里，于是"用户明明绑了模型"却被判成"还没绑定模型"。
    getDb()
      .prepare(`UPDATE role_bindings SET model = 'bound-model' WHERE role = 'explain' AND owner_id IS NULL`)
      .run();
    getDb().prepare(`UPDATE providers SET enabled = 0 WHERE id = 'openai-default'`).run();
    addProvider('p-live', null, 'sk-live'); // 另一个平台 provider 顶上默认兜底

    const t = routeRole('explain', undefined, 'uA')!;
    expect(t.baseUrl).toBe('https://p-live.example/v1');
    expect(t.model).toBe('bound-model');
    expect(roleReady('explain', 'uA').ok).toBe(true);
  });
});
