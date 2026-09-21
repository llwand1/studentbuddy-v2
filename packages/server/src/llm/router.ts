/**
 * llm/router — model-router 多角色路由（演进①）。
 * 五角色（讲解/出题/题解/分析/总结）各自绑定 provider+model，未配置落默认 provider。
 * 扩展语义：换出题模型=改一条绑定，不动代码。
 *
 * ── M2c（2026-09-18）：归属 —— 「**这轮是谁在问**」────────────────────────────────
 * 契约 `docs/TENANCY-SPEC.md` §8.1。背景是老板拍板的**双通道并存**：用户可以自带 key（BYOK，他付钱），
 * 平台也提供免费额度（平台付钱）。**两条通道必须能在同一次 `routeRole` 调用里被区分**——
 * 做不到的话，「免费用户烧到付费用户的 key」与「付费用户被免费额度截断」会**同时发生**。
 *
 * ★ `ownerId` 走**显式第三参**，不引 `AsyncLocalStorage`（§8.1.4 拍板，四条理由原文在契约里）。
 *   最关键的一条：本片的本质是「谁付模型钱」，显式参数让**每个调用点都必须回答「这是谁在问」**；
 *   ALS 把它藏进隐式上下文，**漏设时静默退化成平台通道**——而那正是本片要消灭的 bug。
 *   即「同一个失败模式，一个写在代码里，一个不写」。
 *
 * ★ `ownerId` 三态语义（**别把 `null` 与 `undefined` 当同一件事**）：
 *   · `string`  → 登录用户：先查**他自己**的绑定，查不到回落到平台通道；
 *   · `null`    → **未登录的单人本地模式**（口径同 `auth/ownership.ts:26` 的 `ownerFilter(null)`）：
 *                 不做归属判定，直接用**平台通道**——老库升级后既有绑定回填的就是 `NULL`，故行为不变；
 *   · 省略      → 同 `null`（保持本批之前所有调用点的既有行为，也让单测不必逐个补参）。
 *   ★ 平台通道的判据是 `owner_id IS NULL`，**不是 `''`**（`''` 会落进「某个不存在的用户」的空档）。
 *
 * ★ `ownerId` 还**顺带**决定了上游配额怎么分桶（契约 §8.1.3.1 两层闸门）：`routeRole` 把
 *   `{ ownerId, platform }` 用 `bindQuota()` 绑在**返回的 `adapter` 上**，于是调用方
 *   「零改动、也不可能漏传」。★ 三档各自的配额语义见下方 `routeRole` 内注释。
 */
import type { ModelRole, Provider } from '@sb/shared';
import { getDb } from '../storage/db.js';
import type { LLMAdapter, UpstreamQuota } from './types.js';
import { OpenAICompatibleAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { bindQuota } from './upstream-gate.js';
import { firstPlatformProviderId, platformDefaultModel, resolveProviderCredentials } from './platform-channel.js';

export const MODEL_ROLES: Array<{ role: ModelRole; label: string }> = [
  { role: 'explain', label: '讲解（日常对话）' },
  { role: 'quiz-generator', label: '出题' },
  { role: 'solver', label: '题解' },
  { role: 'analyzer', label: '薄弱点分析' },
  { role: 'summarizer', label: '总结' },
  // P0-7 新增：PK 裁判（出理解题/判贴合度/给建议）。数组驱动 ⇒ 默认绑定 INSERT 与设置页渲染都自动带上，无需迁移
  { role: 'judge', label: '裁判（PK 判题）' },
  // v17 新增：视觉（看图）。纯文本主模型借它「读图」——图→视觉模型→文字描述→塞回主模型上下文。
  // 数组驱动 ⇒ 设置页「角色模型绑定」自动多出一列，无需额外写 UI；未绑定时 flow 给清晰报错。
  { role: 'vision', label: '视觉（看图）' },
  // v25 新增：督促（复习陪练）。小窗里那个盯着欠账说话的 AI。
  // ★ 与 vision 不同，**未绑定不是错误**：`learning/coach.ts` 的 resolveCoachTarget()
  //   会回退讲解模型——督促本质是日常对话，而老库升级后 role_bindings 里本来就没有这一行，
  //   若按「必须绑定」处理，用户看到的是「该角色还没绑定模型」而他从没改过任何设置。
  { role: 'coach', label: '督促（复习陪练）' },
];

const adapters: Record<'openai' | 'anthropic', LLMAdapter> = {
  openai: new OpenAICompatibleAdapter(),
  anthropic: new AnthropicAdapter(),
};

export interface RoutedTarget {
  /**
   * ★ M2c：**已绑好配额的**适配器（`bindQuota`）——每次 `chat()` 自动把 `quota` 塞进请求，
   *   调用方无感。★ 这是「不可能漏传」的实现方式：拿不到本字段就没有 `apiKey`/`baseUrl`，
   *   也就发不出请求；而一旦拿到，配额就一定在里面（见 `upstream-gate.ts` 文件头）。
   */
  adapter: LLMAdapter;
  model: string;
  apiKey: string;
  baseUrl: string;
  /** 回答呈现形态（v13）：stream=逐字流式（原生 AI 全过程）；once=一次性回答（池中 AI） */
  streamMode: 'stream' | 'once';
  /** 上游配额的归属维度（M2c）。★ 同时暴露出来供诊断/测试断言，正常路径不必读它 */
  quota: UpstreamQuota;
}

/** stream_mode 缺省按 type 定位：anthropic 原生协议=流式；openai 兼容（中转池）=一次性 */
function normalizeStreamMode(raw: string | null | undefined, type: string): 'stream' | 'once' {
  if (raw === 'stream' || raw === 'once') return raw;
  return type === 'anthropic' ? 'stream' : 'once';
}

/**
 * 可见的服务商：**平台的 + 自己的**（M2c 归属过滤）。
 *
 * ★ `owner_id IS NULL OR owner_id = ?` 一条语句覆盖两种调用方，靠的是 SQL 的一个硬事实：
 *   **`owner_id = NULL` 永远不成立**（三值逻辑，结果是 UNKNOWN 而非 TRUE）。所以
 *   `ownerId === null`（本地单人模式）时后半句自动失效，只剩 `owner_id IS NULL`——
 *   而本地模式下**所有** provider 的 owner 都是 NULL（老库回填值），等于"全都能看见"，
 *   与加归属之前的行为一致。
 * ★ 平台 provider 对登录用户**必须可见**：不给他看，他就没法把角色绑到免费通道上。
 *   可不可改是另一回事，由 `routes.ts` 的归属断言管。
 */
export function getProviders(ownerId: string | null = null): Provider[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, base_url, api_key, type, enabled, stream_mode, owner_id FROM providers
        WHERE owner_id IS NULL OR owner_id = ?
        ORDER BY created_at`,
    )
    .all(ownerId) as Array<{
    id: string;
    name: string;
    base_url: string;
    api_key: string;
    type: string;
    enabled: number;
    stream_mode: string | null;
    owner_id: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    enabled: r.enabled === 1,
    streamMode: normalizeStreamMode(r.stream_mode, r.type),
    ownerId: r.owner_id,
  }));
}

/**
 * 按 id 取 provider，**同时断言归属**。
 *
 * ★ 为什么归属必须在这一层断言（而不是"信绑定表里的 provider_id"）：绑定是用户可写的
 *   （`PUT /roles/:role`），若只按 id 取，**任何人把角色的 provider_id 写成别人的 id 就能
 *   烧别人的 key**——那正是本片要消灭的洞，且从"读口"进来比从"写口"更隐蔽。
 *
 * ★ 判据是 `owner_id IS NULL OR owner_id IS ?`（**不是** `owner_id IS ?`）：**平台 provider 对谁都可见可用**。
 *   这不是放水，而是双通道并存的必要部分——用户完全可能「走免费通道、但换个模型」（例如把
 *   `summarizer` 绑到平台 provider 上的便宜模型），把它判成越权会让免费通道失去可调性。
 *   挡住的是「别人的 key」，那一条由 `owner_id IS ?` 那半边负责。
 *   `owner = null`（本地单人模式）时两半边等价，退化成"只看平台行"，与既有行为一致。
 */
function providerById(id: string, owner: string | null) {
  return getDb()
    .prepare(
      `SELECT id, name, base_url, api_key, type, enabled, stream_mode, owner_id FROM providers
        WHERE id = ? AND (owner_id IS NULL OR owner_id IS ?)`,
    )
    .get(id, owner) as
    | {
        id: string;
        name: string;
        base_url: string;
        api_key: string;
        type: string;
        enabled: number;
        stream_mode: string | null;
        owner_id: string | null;
      }
    | undefined;
}

/**
 * 默认目标：第一个 enabled 的**平台** provider（兼容未配置角色绑定的开箱路径）。
 *
 * ★ 限定 `owner_id IS NULL`（由 `firstPlatformProviderId()` 保证）：兜底路径**绝不能**取
 *   "任意 owner 的第一个 provider"——那会让"平台绑定缺失"变成"随机用某个用户的 key 付账"。
 *   宁可返回 null 让调用方报「没有可用的服务商」，也不要静默花别人的钱。
 * ★ `requester`（M2c）是**请求者**，只用于填配额（内层按它分桶）；provider 仍取平台行。
 */
function defaultTarget(requester: string | null): RoutedTarget | null {
  const first = firstPlatformProviderId();
  if (!first) return null;
  return targetFromProvider(first, null, requester);
}

/**
 * 由 provider 行造目标。
 * @param owner      **可见性**归属（`null` = 取平台行；非 null = 允许"平台行或该用户的"）
 * @param requesterId  **请求者**，只用于配额分桶（M2c）。★ 与 `owner` **不是同一件事**：
 *                   平台通道的 provider 其 `owner` 恒为 `null`，而配额里的 `ownerId` 是
 *                   请求者——两者混用会让所有免费用户挤进同一个内层桶（见 `upstream-gate.ts` 文件头）。
 *
 * ★★ 「谁付钱」（`quota.platform`）**由这个 provider 是谁的**决定，不由调用方从哪条分支进来决定。
 *   2026-09-21 修：此前 ① 分支硬写 `platform: false`，于是**登录用户把角色绑到平台 provider**
 *   时同时坏两件事——env 里的平台 key 不被注入（`apiKey` 变成空串）+ 这轮调用**不计入**
 *   250 次/5 小时的免费额度（被误判成"平台不付钱"）。实测（`router.test.ts` 回归锁）：
 *     · 未绑自己的  → apiKey=sk-PLATFORM-ENV、platform:true  ✅
 *     · 绑到平台行  → apiKey=""、platform:false              ❌（本函数修的就是它）
 *   判据改成"provider 行是不是 `owner_id IS NULL`"后，① 与 ②③ 三个分支终于同口径。
 *   与 ②③ 的一致性不是巧合——那两条分支本来就按"平台行"注入 env，只有 ① 漏了。
 */
function targetFromProvider(providerId: string, owner: string | null, requesterId: string | null): RoutedTarget | null {
  const p = providerById(providerId, owner);
  if (!p || p.enabled !== 1) return null;
  const type = p.type === 'anthropic' ? 'anthropic' : 'openai';
  const creds = resolveProviderCredentials(p);
  const quota: UpstreamQuota = { ownerId: requesterId, platform: p.owner_id === null };
  return {
    adapter: bindQuota(adapters[type], quota),
    model: '', // model 由角色绑定或平台默认给出
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    streamMode: normalizeStreamMode(p.stream_mode, p.type),
    quota,
  };
}

/** 取某归属下某角色的绑定行。`owner === null` ⇒ 平台行（`owner_id IS NULL`）。 */
function bindingFor(role: ModelRole, owner: string | null): { provider_id: string; model: string } | undefined {
  return getDb()
    .prepare('SELECT provider_id, model FROM role_bindings WHERE role = ? AND owner_id IS ?')
    .get(role, owner) as { provider_id: string; model: string } | undefined;
}

/**
 * 角色 → 可用的上游目标。查序**三档，顺序不可换**：
 *   ① 本人绑定（仅登录用户）→ ② 平台绑定 → ③ 平台默认 provider。
 *
 * ★ 为什么 ② 对**登录用户**也要查：不查就等于「BYOK 用户只要漏绑一个角色，那个角色直接不可用」，
 *   而老板的决策是**双通道并存**——没自带 key 的人本来就该走免费通道。
 * ★ 为什么 ① 的 provider 失效时**落到 ②**、而不是「拿本人的 model 配平台的 provider」：
 *   两者不是同一个服务商，模型名大概率不存在 ⇒ 那会变成一次必然失败的调用。
 *   落到平台绑定是**整条链一起换**，语义上就是"免费通道顶上"，这才是能跑通的降级。
 */
export function routeRole(
  role: ModelRole,
  fallbackModel?: string,
  ownerId?: string | null,
): (RoutedTarget & { model: string }) | null {
  const owner = ownerId ?? null;

  if (owner !== null) {
    const mine = bindingFor(role, owner);
    if (mine) {
      // ① 自己的绑定行。★ 但"自己绑的"**不等于**"自己的 key"——绑定可以指向平台 provider
      //   （设置页的「一键默认设置」正是这么配的，测试也钉了「免费通道要可调」这条）。
      //   故 `platform` 不在这里定，交给 `targetFromProvider` 按 provider 行的归属判。
      const t = targetFromProvider(mine.provider_id, owner, owner);
      if (t) {
        // ★ 绑定行 model 为空 ⇒ 走与 ② 同一条回落链（env > 常量）。
        //   不兜这一层的话，「一键默认」把 8 个角色绑好、model 留空之后，
        //   `roleReady` 会判「该角色还没绑定模型」——配了却不可用。
        return { ...t, model: mine.model || (t.quota.platform ? platformDefaultModel() : '') };
      }
    }
  }

  const platform = bindingFor(role, null);
  if (platform) {
    // ② 平台绑定 ⇒ **平台付钱**。★ 但配额里的 `ownerId` 仍是**请求者**——
    //    内层「每用户 2」正是靠它分桶；若这里图省事写 `null`，所有免费用户会挤进同一个桶。
    const t = targetFromProvider(platform.provider_id, null, owner);
    // ★ v39 零配置的**另一半**：光有 key 没有模型名，`roleReady()` 照样判「该角色还没绑定模型」，
    //   AI 依然不可用（线上 2026-09-21 就是这个状态：`role_bindings.model` 八行全空）。
    //   故绑定表 model 为空时用平台默认模型兜底。优先级＝**绑定表 > env > 常量**：
    //   设置页配的是"这台部署要用的模型"（可随时改），env 只是部署默认值。
    if (t) return { ...t, model: platform.model || platformDefaultModel() };
  }

  const def = defaultTarget(owner);
  if (!def) return null;
  // 默认路径：绑定表存每角色默认 model（M1 由设置页写入），缺省用调用方给的模型名。
  // ★ 本路径**可达且带 `platform`**：上面的 ② 里 `targetFromProvider` 返回 null（provider
  //   被停用/被删）时会落到这里。故 `platform?.model` **必须留着**——v39 首次改动时曾把它
  //   换成 `platformDefaultModel()`，等于把"绑定表里写着的模型"丢了，是本次自查抓出来的回归。
  //   优先级与 ② 一致：**绑定表 > env > 常量**。
  // ★ 2026-09-21：`platformDefaultModel()` 现在恒返回非空（末位兜 `DEFAULT_PLATFORM_MODEL`），
  //   故 `|| fallbackModel || ''` 两段实际已不可达。**保留而不删**：删掉要动 16 处调用点的
  //   签名（第 2 参一去掉，第 3 参就错位），收益不抵风险。留作后续清理项。
  return { ...def, model: platform?.model || platformDefaultModel() || fallbackModel || '' };
}

/**
 * 角色目标可用性：供各域在失败时区分「**没配**」与「跑挂了」，好让报错说真话（ADR-5）。
 * 2026-09-13 新增——出题曾把「模型没配」与「输出没解析出来」混成一句「模型不可用，可重试」，
 * 用户照着不停重试，永远调不到点子上。
 * ★ M2c 起带上 `ownerId`：报错文案必须与**实际会用的那条通道**一致，否则会出现
 *   「用户自己有 key，却被告知去设置页绑模型」这种驴唇不对马嘴的提示。
 * ★ 2026-09-21 加**密钥检查**：此前只判 model 非空。那是 v39 之前成立的——那时平台行的
 *   key 存在数据库里，"有模型"基本等价于"能用"。v39 把平台 key 挪到 env、又给 model 加了
 *   常量兜底之后，「**model 有值但 key 是空的**」成了一个**新的、且正是当前线上**的状态
 *   （`SB_PLATFORM_*` 一条没配）。不判这条的话，用户看到的是"配好了"，然后每次提问撞 401。
 *   ★ 文案刻意写成「平台免费通道还没开通（服务商密钥未配置）」而不是「密钥没配」：
 *   调用方（`routes/quiz.ts` / `routes/scenario.ts`）会在这句后面拼
 *   「——请到「设置」→「角色模型绑定」绑定模型后再试」，而**对用户而言那正是正确的下一步**
 *   （平台的 key 他改不了，他能做的是配自己的模型）。故这里不改调用点，只把首句写准。
 */
export function roleReady(role: ModelRole, ownerId?: string | null): { ok: boolean; reason: string } {
  const t = routeRole(role, undefined, ownerId);
  if (!t) return { ok: false, reason: '没有启用的服务商' };
  if (!t.model) return { ok: false, reason: '该角色还没绑定模型' };
  if (!t.apiKey) return { ok: false, reason: '平台免费通道还没开通（服务商密钥未配置）' };
  return { ok: true, reason: '' };
}

/** 空库种子：无 provider 时注入 openai-default（apiKey 留空待用户填，开箱不 500）。 */
export function seedIfEmpty(): void {
  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number }).c;
  if (count > 0) return;
  const seed = getDb().transaction(() => {
    // 显式写 owner_id = NULL：种子 provider 是**平台**的（免费通道的落点），不是"当前用户"的
    getDb()
      .prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, owner_id) VALUES ('openai-default', '默认服务商', 'https://api.openai.com/v1', '', 'openai', 1, NULL)`)
      .run();
    for (const { role } of MODEL_ROLES) {
      // ★ `INSERT OR REPLACE` → `INSERT OR IGNORE`：平台行的唯一性由**部分唯一索引**
      //   `idx_role_bindings_platform` 保证（复合 PK 在 SQLite 下不拦 NULL，见迁移 v29 注释）。
      //   `OR REPLACE` 会「删掉旧行再插」，等于每次种子都重写一遍；`OR IGNORE` 是"有了就别动"，
      //   与 `seedIfEmpty` 的名字和意图一致，也不会把用户后来改过的平台绑定打回去。
      getDb()
        .prepare(`INSERT OR IGNORE INTO role_bindings (owner_id, role, provider_id, model) VALUES (NULL, ?, 'openai-default', '')`)
        .run(role);
    }
  });
  seed();
}
