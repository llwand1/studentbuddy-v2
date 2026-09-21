/**
 * routes/providers — 服务商 CRUD / 角色模型绑定 / 模型列表 / 平台免费额度。
 *
 * ★ **为什么从 `routes.ts` 拆出来**：本批加「一键默认设置」与「免费额度查询」两个端点后
 *   `routes.ts` 会越过 `server/.ts ≤400` 红线（拆前 353 行）。按仓规**拆文件、不压注释**
 *   ——判据与 `routes/settings.ts` 那次完全相同：**设置域是「每加一个能力就多一组端点」的
 *   独立增长块**，与会话 CRUD 的修改频率和增长方向都不相干。
 * ★ `routes.ts` 改为 **re-export**，保住 `index.ts` 里 `app.use('/api/providers', providersRouter)`
 *   的既有调用方零改动（同 `settingsRouter` 的既有手法）。
 * ★ 本文件**零业务逻辑**（ADR-3）：只做参数校验与「调 storage / llm」。
 *
 * ── 2026-09-21 本批的两件事（老板原话：「配置设置哪里可不可以改得更加方便一点…并且搞一个
 *    「一键默认设置」按钮，按了之后就一键全部配完，使用服务默认的 agnes-2.5-flash 的免费限额」）
 *   ① `POST /roles/default` —— 一键默认设置：把请求者的 8 个角色全部绑到**平台通道**。
 *   ② `GET /quota` —— 免费额度剩余次数（前端显示"还剩 N 次"）。
 *   外加一处必要修复：`GET /:id/models` 对平台行要注入 env 凭据，否则模型列表**永远拉不到**
 *   （v39 起平台行的 `api_key` 恒为空，而 `listModels` 拿不到 key 只会静默返回 `[]`）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../storage/db.js';
import { MODEL_ROLES, getProviders, seedIfEmpty } from '../llm/router.js';
import {
  firstPlatformProviderId,
  platformDefaultModel,
  resolveProviderCredentials,
} from '../llm/platform-channel.js';
import { OpenAICompatibleAdapter } from '../llm/openai.js';
import { AnthropicAdapter } from '../llm/anthropic.js';
import { encryptSecret, decryptSecret, isEncrypted } from '../storage/crypto.js';
import { ownerIdOf } from '../auth/ownership.js';
import { platformQuotaState } from '../llm/platform-quota.js';
import { PLATFORM_QUOTA_MAX_CALLS } from '@sb/shared';

// ── providers / 角色绑定（M2c：归属，契约 docs/TENANCY-SPEC.md §8.1）────────
export const providersRouter = Router();

/**
 * 这个 provider **能不能被当前请求改/删**？三态返回，因为三种情况的正确响应码不同。
 *
 * ★ **读口与写口刻意用不同判据**，这不是不一致，是两类操作的风险不同：
 *   · **读/用**（`llm/router.ts` 的 `providerById`）＝ `平台 OR 自己的` —— 平台 provider 对谁都可用，
 *     否则用户没法把角色绑到免费通道上，免费额度成摆设；
 *   · **写/删**（本函数）＝ **严格自己的** —— 用户改一次平台 provider 的 baseUrl，
 *     **全站所有人的模型都跟着变**（§8.1 原文：从「能改别人的」升级成「能改所有人的」）。
 * ★ 平台行对登录用户回 **403 而不是 404**：该 provider **本来就在他的列表里**（读口可见），
 *   装"不存在"是撒谎，也会让用户反复重试。而**别人的** provider 回 404——
 *   那是「这个 id 存在，只是不是你的」，与本仓 sessions 的口径一致（TENANCY-SPEC §5）。
 * ★ 本地单人模式（`owner === null`）可以改平台行：那时操作者**就是**平台自己。
 */
function editableProvider(id: string, owner: string | null): 'ok' | 'platform' | 'missing' {
  const row = getDb().prepare('SELECT owner_id FROM providers WHERE id = ?').get(id) as
    | { owner_id: string | null }
    | undefined;
  if (!row) return 'missing';
  if (row.owner_id === null) return owner === null ? 'ok' : 'platform';
  return row.owner_id === owner ? 'ok' : 'missing';
}

/** 写口守卫：不通过就直接回响应并返回 false（调用方据此 return）。 */
function guardEditable(res: Response, id: string, owner: string | null): boolean {
  const verdict = editableProvider(id, owner);
  if (verdict === 'platform') {
    res.status(403).json({ error: '平台服务商不可修改：它决定全站默认模型，改了会影响所有用户' });
    return false;
  }
  if (verdict === 'missing') {
    res.status(404).json({ error: 'provider 不存在' });
    return false;
  }
  return true;
}

providersRouter.get('/', (req: Request, res: Response) => {
  seedIfEmpty();
  // 内部已显式挑选出站字段（无 api_key），不必再 map 一层；归属过滤在 getProviders 里
  res.json(getProviders(ownerIdOf(req)));
});

providersRouter.post('/', (req: Request, res: Response) => {
  const { name, baseUrl, apiKey, type, streamMode } = req.body as {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    type?: string;
    streamMode?: string;
  };
  if (!name || !baseUrl) {
    res.status(400).json({ error: 'name 与 baseUrl 必填' });
    return;
  }
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const t = type === 'anthropic' ? 'anthropic' : 'openai';
  // stream_mode 缺省按 type 定位（池中=一次性，原生=流式）；显式传入则尊重
  const mode = streamMode === 'stream' || streamMode === 'once' ? streamMode : t === 'anthropic' ? 'stream' : 'once';
  // ★ 新建的 provider 一律挂**当前用户**名下（未登录单人模式 ⇒ NULL = 平台自己的）
  getDb()
    .prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, stream_mode, owner_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, name, baseUrl, encryptSecret(apiKey ?? ''), t, mode, ownerIdOf(req));
  res.status(201).json({ id, name, baseUrl });
});

providersRouter.put('/:id', (req: Request, res: Response) => {
  const { name, baseUrl, apiKey, enabled, streamMode } = req.body as {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    enabled?: boolean;
    streamMode?: string;
  };
  const id = req.params.id ?? '';
  if (!guardEditable(res, id, ownerIdOf(req))) return;
  const db = getDb();
  const mode = streamMode === 'stream' || streamMode === 'once' ? streamMode : null;
  // apiKey 传空/缺省 = 不修改；传明文 = 更新密文（幂等：已是密文则原样）
  if (apiKey === undefined || apiKey === '') {
    db.prepare(`UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), stream_mode = COALESCE(?, stream_mode), enabled = COALESCE(?, enabled) WHERE id = ?`)
      .run(name ?? null, baseUrl ?? null, mode, enabled === undefined ? null : enabled ? 1 : 0, id);
  } else {
    db.prepare(`UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), api_key = ?, stream_mode = COALESCE(?, stream_mode), enabled = COALESCE(?, enabled) WHERE id = ?`)
      .run(name ?? null, baseUrl ?? null, encryptSecret(apiKey), mode, enabled === undefined ? null : enabled ? 1 : 0, id);
  }
  res.json({ ok: true });
});

providersRouter.delete('/:id', (req: Request, res: Response) => {
  const id = req.params.id ?? '';
  const owner = ownerIdOf(req);
  if (!guardEditable(res, id, owner)) return;
  getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
  // ★ 兜底改绑**必须限定同一归属**：不加 `owner_id IS ?` 会跨用户改别人的绑定
  //   （删自己一个 provider，顺手把别人的模型指向 openai-default）。
  getDb()
    .prepare(`UPDATE role_bindings SET provider_id = 'openai-default' WHERE provider_id = ? AND owner_id IS ?`)
    .run(id, owner);
  res.json({ ok: true });
});

providersRouter.get('/roles', (req: Request, res: Response) => {
  seedIfEmpty();
  const owner = ownerIdOf(req);
  // 平台行 + 本人行，然后**同 role 合成一条 = 实际会生效的那条**（本人的覆盖平台的）。
  // ★ 为什么不把两组都回给前端让它自己挑：那等于把 `routeRole` 的查序在 UI 里抄第二遍，
  //   两处迟早不一致（本仓对"同一事实写两遍"付过多次学费）。这里回的就是**结果**。
  const rows = getDb()
    .prepare('SELECT owner_id, role, provider_id, model FROM role_bindings WHERE owner_id IS NULL OR owner_id = ?')
    .all(owner) as Array<{ owner_id: string | null; role: string; provider_id: string; model: string }>;
  const effective = new Map<string, { role: string; provider_id: string; model: string }>();
  for (const r of rows) {
    // 后写覆盖前写，但**只有"本人的行"允许覆盖**——平台行永远不覆盖已存在的条目。
    // 这样无论 SQL 返回的行序如何，结果都是"本人优先"，不依赖 ORDER BY。
    if (!effective.has(r.role) || r.owner_id !== null) {
      effective.set(r.role, { role: r.role, provider_id: r.provider_id, model: r.model });
    }
  }
  res.json({ roles: MODEL_ROLES, bindings: [...effective.values()] });
});

/**
 * **一键默认设置**（2026-09-21 老板拍板）。
 *
 * 把**请求者自己的** 8 个角色全部绑到平台通道，`model` 一律写**空串**。
 *
 * ── 为什么是"每个用户各点各的"，不是"改全站平台绑定" ─────────────────────────
 * 老板原话：「这个一键配置是给用户使用的，也就是我说的 250 次/5 小时的免费额度使用的就是
 * 这个一键配置的设置」。⇒ 它是一个**用户自助**动作（回到免费通道），不是管理员动作。
 * 写 `owner_id = NULL` 的平台行会让"任何人点一下都改到全站所有人"，那是权限事故。
 * ★ 本地单人模式（`owner === null`）例外：那时操作者**就是**平台自己，写平台行才对
 *   —— 与 `PUT /roles/:role` 的既有判据逐字一致（`owner === null` 走平台行分支）。
 *
 * ── 为什么 `model` 写空串而不是写 `agnes-2.5-flash` ─────────────────────────
 * 写死进去就成了**第二个真相源**：`role_bindings.model` 的优先级高于 `SB_PLATFORM_MODEL`，
 * 于是运维改 env 换模型时全站纹丝不动（详见 `@sb/shared/platform-channel` 文件头）。
 * 留空 ⇒ 生效链恒为「绑定表 > env > 常量」，改 env 立刻全站生效、不必碰数据。
 * ★ 配套改动（缺一不可）：`router.ts` 的 ① 分支要为"绑到平台行且 model 为空"补 env 回落，
 *   否则一键配完 8 个角色会全部报「该角色还没绑定模型」——配了却不可用。
 *
 * ── 为什么 key 不会因此暴露 ───────────────────────────────────────────────
 * 本端点只写 `provider_id` 与 `model`，**一个字节的凭据都不落库**。平台 key 始终只存在于
 * 服务端 env（`SB_PLATFORM_API_KEY`），平台行的 `api_key` 列保持空串 ⇒ 拖库/接口泄漏都拿不到。
 */
providersRouter.post('/roles/default', (req: Request, res: Response) => {
  const owner = ownerIdOf(req);
  const providerId = firstPlatformProviderId();
  if (!providerId) {
    // 409 而不是 500：这是"当前没有可用的平台服务商"这个**已知状态**，不是故障。
    // 也不回 200 假装成功——那样用户会以为配好了，然后每次提问撞「没有启用的服务商」。
    res.status(409).json({ error: '平台免费通道暂不可用（没有启用的平台服务商）' });
    return;
  }
  const db = getDb();
  // ★ 8 条绑定必须**同生共死**：中途失败留下一半，用户看到的是"一半角色能用、一半不能用"，
  //   而设置页显示的是"已配置"——最难查的那种半成品状态。
  db.transaction(() => {
    for (const { role } of MODEL_ROLES) {
      // 两条写路径、两个冲突目标，**不能合并**：用户行命中复合 PK `(owner_id, role)`；
      // 平台行的 PK 在 SQLite 下对 NULL 不生效（见迁移 v29 注释），只能命中部分唯一索引，
      // 故冲突目标要带同样的 WHERE。与 `PUT /roles/:role` 同一手法。
      if (owner === null) {
        db.prepare(
          `INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (NULL, ?, ?, '')
           ON CONFLICT(role) WHERE owner_id IS NULL DO UPDATE SET provider_id = excluded.provider_id, model = ''`,
        ).run(role, providerId);
      } else {
        db.prepare(
          `INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (?, ?, ?, '')
           ON CONFLICT(owner_id, role) DO UPDATE SET provider_id = excluded.provider_id, model = ''`,
        ).run(owner, role, providerId);
      }
    }
  })();
  // 回给前端"配完之后实际会用哪个模型"，好让设置页当场显示出来（而不是让用户猜）
  res.json({ ok: true, providerId, model: platformDefaultModel(), roles: MODEL_ROLES.length });
});

providersRouter.put('/roles/:role', (req: Request, res: Response) => {
  const { providerId, model } = req.body as { providerId?: string; model?: unknown };
  if (!providerId) {
    res.status(400).json({ error: 'providerId 必填' });
    return;
  }
  // ★ 2026-09-21：`model` **允许为空串**（此前必填）。空 = 「用该服务商的默认模型」，
  //   与「一键默认设置」写的是同一个值（`POST /roles/default` 也写空）。
  //   两处口径必须一致：否则用户点完一键默认，再想手动把某个角色改回"用默认"就做不到——
  //   界面给得出这个选项，服务端却 400，是最难解释的一类不一致。
  //   空值的安全性由 `routeRole` 兜：平台行 ⇒ 回落 env/常量；BYOK 行 ⇒ 回落空 ⇒
  //   `roleReady` 明确报「该角色还没绑定模型」，不会静默用错模型。
  // ★ 非字符串（数字/null/对象）一律当未提供处理，不做隐式转换——`String(123)` 会造出
  //   一个叫 "123" 的幽灵模型名。
  const modelValue = typeof model === 'string' ? model.trim() : '';
  const owner = ownerIdOf(req);
  // ★ 先验 provider **可见**（平台或自己的）再落库：不验的话，把 provider_id 写成别人的 id
  //   也能写进自己的绑定行——虽然 `routeRole` 的归属断言会让它取不到（不会泄露 key），
  //   但用户看到的是"绑定成功了、用起来却没生效"，一个自己造出来的幽灵。
  const visible = getDb()
    .prepare('SELECT id FROM providers WHERE id = ? AND (owner_id IS NULL OR owner_id IS ?)')
    .get(providerId, owner) as { id: string } | undefined;
  if (!visible) {
    res.status(400).json({ error: 'provider 不存在或不属于你' });
    return;
  }
  // ★ 两条写路径、两个冲突目标，**不能合并**：见 `POST /roles/default` 的同段注释。
  if (owner === null) {
    getDb()
      .prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (NULL, ?, ?, ?)
                ON CONFLICT(role) WHERE owner_id IS NULL DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`)
      .run(req.params.role, providerId, modelValue);
  } else {
    getDb()
      .prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (?, ?, ?, ?)
                ON CONFLICT(owner_id, role) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`)
      .run(owner, req.params.role, providerId, modelValue);
  }
  res.json({ ok: true });
});

/**
 * 平台免费额度的剩余次数（前端显示"还剩 N 次"）。
 *
 * ★ 为什么要有这个端点：老板的免费额度是**每 5 小时 250 次**的滚动窗口，用户看不见剩余量
 *   时，唯一能做的事就是"撞到超限才知道"——那是 ADR-5 要消灭的失败模式。
 * ★ 未登录单人模式回 `limited: false` 而不是编一个 250：那条路径**根本不计费**
 *   （`upstream-gate.ts`：`platform && ownerId === null` ⇒ 不计数），编个数字就是撒谎。
 *   ★ 判据必须与闸门**逐字一致**，否则会出现"设置页说还剩 240 次，实际早就被拒了"。
 */
providersRouter.get('/quota', (req: Request, res: Response) => {
  const owner = ownerIdOf(req);
  if (owner === null) {
    res.json({ limited: false, used: 0, limit: PLATFORM_QUOTA_MAX_CALLS, windowStart: 0, resetAt: 0 });
    return;
  }
  res.json({ limited: true, ...platformQuotaState(owner) });
});

/**
 * 模型列表（v13 接入半成品能力）：按 provider 类型实例化适配器，透传该 provider
 * **实际会用**的凭据拉取真实可用模型。失败返回空数组（前端保持手填输入框可用）。
 *
 * ★ 归属用**读口判据**（平台 OR 自己的）：平台 provider 的模型列表必须可拉，
 *   否则用户把角色绑到免费通道时无法选择模型（绑定表单要靠它填下拉）。
 * ★ 2026-09-21 修：凭据改走 `resolveProviderCredentials()`。此前直接
 *   `decryptSecret(row.api_key)` —— 对平台行那是**恒为空串**（v39 起平台 key 只在 env），
 *   于是设置页对平台服务商**永远拉不到模型列表**，而 `listModels` 把 401 吞成 `[]`，
 *   用户看到的是"没拉到模型列表（检查 baseUrl/key）"——一句指向错误方向的提示。
 *   ★ 这条不泄露 key：返回值只有模型名，key 在服务端就用掉了。
 */
providersRouter.get('/:id/models', async (req: Request, res: Response) => {
  const row = getDb()
    .prepare('SELECT type, base_url, api_key, owner_id FROM providers WHERE id = ? AND (owner_id IS NULL OR owner_id IS ?)')
    .get((req.params.id ?? ''), ownerIdOf(req)) as
    | { type: string; base_url: string; api_key: string; owner_id: string | null }
    | undefined;
  if (!row) {
    res.status(404).json({ error: 'provider 不存在' });
    return;
  }
  const adapter = row.type === 'anthropic' ? new AnthropicAdapter() : new OpenAICompatibleAdapter();
  const models = await adapter.listModels(resolveProviderCredentials(row));
  res.json({ models });
});

/** 开发辅助：验证密钥加解密往返（密文状态自查，不回显明文）。 */
providersRouter.get('/:id/key-status', (req: Request, res: Response) => {
  const row = getDb()
    .prepare('SELECT api_key FROM providers WHERE id = ? AND (owner_id IS NULL OR owner_id IS ?)')
    .get((req.params.id ?? ''), ownerIdOf(req)) as { api_key: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const roundtrip = row.api_key ? decryptSecret(row.api_key).length > 0 : true;
  res.json({ encrypted: isEncrypted(row.api_key), roundtrip });
});
