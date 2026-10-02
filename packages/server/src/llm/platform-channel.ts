/**
 * llm/platform-channel — 平台免费通道的**服务端侧**：落点 provider、凭据、默认模型。
 *
 * ★ 与 `@sb/shared/platform-channel` 的分工（**别混，同名不同层**）：
 *   · 那边（shared）放**前后端共用**的常量（`DEFAULT_PLATFORM_PROVIDER_ID` /
 *     `DEFAULT_PLATFORM_MODEL`）——前端要显示「一键默认会用哪个模型」也读得到；
 *   · 本文件放**只有服务端能碰**的东西——env 里的凭据、数据库里的落点行。
 *     `resolveProviderCredentials()` 的返回值**带明文 key**，禁令写在它自己的注释里。
 *
 * ★ 为什么从 `router.ts` 拆出来：零配置与**多路凭据**两处改动
 *   都往 `router.ts` 加东西，该文件撞到 `server/.ts ≤ 400` 红线（413 行）。本仓约定
 *   「**拆文件优先于压注释**」，故把「凭据怎么解析」整块搬出——它本来就是一个独立关注点：
 *   `router.ts` 关心「**哪个角色**用哪个 provider」，本文件关心「那个 provider 到底
 *   **拿哪把 key、打哪个地址、用什么模型名**」。两处都会改到的地方就撞在一起。
 * ★ 2026-10-02：多路选路口径由「等概率随机」改为「**按 env 顺序优先 + 失败换路**」
 *   （`platformRoutes()`；换路策略在 `upstream-failover.ts`，契约 `docs/TENANCY-SPEC.md` §8.1.3.5）。
 */
import { DEFAULT_PLATFORM_MODEL } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { decryptSecret } from '../storage/crypto.js';

/**
 * 第一个启用的**平台** provider 的 id —— 平台通道的落点。
 *
 * ★ 抽出来的理由：`router.ts` 的 `defaultTarget()`（兜底路径）与 `routes/providers.ts` 的
 *   「一键默认设置」端点都要问同一个问题。两处各写一条 SQL，迟早一处改了另一处没改
 *   （本仓对"同一事实写两遍"付过多次学费）。
 * ★ 限定 `owner_id IS NULL` 是**必须的**：取"任意 owner 的第一个 provider"会让
 *   平台通道的兜底落到某个真实用户的 key 上——静默花别人的钱。
 */
export function firstPlatformProviderId(): string | null {
  const row = getDb()
    .prepare('SELECT id FROM providers WHERE enabled = 1 AND owner_id IS NULL ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * 平台通道的 env 注入（「零配置」）。
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────────
 * `seedIfEmpty` 的注释写着「apiKey 留空待用户填，开箱不 500」——那是**给自带 key 的用户**
 * 设计的开箱路径。平台要的是另一种开箱：**用户什么都不用配，直接用平台的额度**。
 * 两者不冲突，靠本函数区分：**平台行的凭据优先从 env 取**。
 *
 * ── 为什么走 env 而不是把 key 写进数据库 ──────────────────────────────────
 * ① **不让用户看到**。`getProviders()` 会把平台行回给前端（`ownerId: null`），
 *    而它本来就不返回 `api_key` 字段——把 key 留在 env ⇒ **数据库里那把 key 永远是空的**，
 *    任何 SQL 注入/拖库/接口泄漏都拿不到它。写进库则多一份可被读到的副本。
 * ② env 是**部署配置**，不该变成数据。写进库就有了两个真相源（改 env 不生效、改库不持久）。
 * ③ 轮换 key 只需改 env + 重启，不必碰数据。
 *
 * ── 三条各自的兜底语义（都不破坏既有行为）────────────────────────────────
 * · `SB_PLATFORM_API_KEY` 未配 ⇒ 回落数据库值（老部署 / BYOK 自建 provider 照常）；
 * · `SB_PLATFORM_BASE_URL` 未配 ⇒ 回落数据库值（线上现为 `https://api.openai.com/v1`，
 *   而平台实际用中转 ⇒ **部署时必须显式配这一条**，否则零配置会打到一个用不了的地址）；
 * · `SB_PLATFORM_MODEL` 未配 ⇒ 回落 `DEFAULT_PLATFORM_MODEL`（`@sb/shared/platform-channel`）。
 *   ★ 从"回落绑定表的 model"改成"回落常量"：「一键默认设置」把绑定行的
 *   model **留空**（单一真相源），于是 `model` 为空成了**正常态**而非"没配"。不兜这一层的话，
 *   一键配完 8 个角色会全部报「该角色还没绑定模型」——配了却不可用。
 *
 * ★ 每次调用都读 `process.env`（而不是模块加载时快照）：`upstream-gate.ts` 那两个常量
 *   是模块级快照，但那是**闸门容量**（启动期定死合理）；本组是**凭据**，测试要能改 env
 *   验证回落链，且运维改完 env 重启即生效、不必担心有别的模块提前读走了旧值。
 */
function platformEnvList(name: 'SB_PLATFORM_API_KEY' | 'SB_PLATFORM_BASE_URL'): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 平台通道的一条候选线路（key 与 baseUrl **按位配对**，整对换）。`index` = env 里出现的位置。 */
export interface PlatformRoute {
  /** env 里出现的位置（**0 = 主力**；仅供诊断/日志，不参与配对计算） */
  index: number;
  apiKey: string;
  baseUrl: string;
}

/**
 * 平台通道的**候选线路**：按 env 里出现的顺序返回**全部有效路**，**第一个＝主力**。
 *
 * ★ 2026-10-02 起平台通道的选路口径＝「**按序优先 + 失败换路**」（契约 §8.1.3.5），
 *   取代了 v39.1 的「等概率随机挑一路」。为什么改：线上曾配 3 路（两把免费 key + 一把付费 key），
 *   实测**两把免费 key 约 12 发就打满限速**（60 发里 48–49 个 429），付费 key 60/60 零 429；
 *   而随机分配会把约 2/3 的请求摊到必限速的免费路上 ⇒ 用户看到
 *   `429 … 免费用户的 API 速率限制`。改为「**按 env 顺序优先**」后，运维把付费路写在第一位
 *   （线上此刻只剩付费一路，顺序天然成立）即可「几乎只走付费」；免费路只作**失败时的备胎**。
 *
 * ★ **配对规则＝`min(keys, bases)`，按位配对（key[i] ↔ base[i]）**：两列表长度不等时**多出的路无效**——
 *   宁可少一路，也不许出现「key 与地址错配」的合法假象（错配必然打向不属于这把 key 的入口）。
 *   ★★ **换路只能整对换**：本函数的每一项都携带成对的 key/baseUrl，调用方换路时**整项替换**，
 *   绝不允许把某一路的 key 配另两路的地址。
 * ★ **单边多值**（只配多把 key、地址未配）在 `platformRoutes()` 里**返回空**（没有可配对的路），
 *   由 `platformEnvPair()` 保留其**旧语义**（随机选一把 key、baseUrl 回落数据库）——见那边注释。
 * ★ 空串 / 纯空白项一律过滤（运维手滑留空格＝未配）。
 */
export function platformRoutes(): ReadonlyArray<PlatformRoute> {
  const keys = platformEnvList('SB_PLATFORM_API_KEY');
  const bases = platformEnvList('SB_PLATFORM_BASE_URL');
  const n = Math.min(keys.length, bases.length);
  const out: PlatformRoute[] = [];
  for (let i = 0; i < n; i++) out.push({ index: i, apiKey: keys[i] ?? '', baseUrl: bases[i] ?? '' });
  return out;
}

/**
 * 平台通道的**主力**那一对（`platformRoutes()[0]`）。
 *
 * ★ 旧实现是「等概率随机挑一路」（v39.1），现改为「取按序候选的第一项」——`resolveProviderCredentials()`
 *   因此**对外语义不变**（仍返回一对 key/baseUrl），但返回的**恒是主力**（不再是随机一路）。
 *   `router.ts` 解析出的目标与换路循环的**第 1 路必须一致**（都取 `platformRoutes()[0]`），
 *   否则会出现「routeRole 说用 A、真正第一发却打了 B」这种只差一行的幽灵。
 * ★ **单边多值的旧语义保留**（不进 `platformRoutes()`）：只配多把 key、地址未配时，
 *   随机选一把 key，baseUrl 照旧回落数据库——这种配置没有"按位配对"可言（baseUrl 只有一个来源：库），
 *   也谈不上换路。★ 这条分支是**兼容遗留部署**用的，线上双多路的正常形态走上面的按序候选。
 * ★ `SB_PLATFORM_MODEL` 仍单值，多路共享同一个模型名。
 */
function platformEnvPair(): { apiKey: string; baseUrl: string } {
  const main = platformRoutes()[0];
  if (main) return { apiKey: main.apiKey, baseUrl: main.baseUrl };
  const keys = platformEnvList('SB_PLATFORM_API_KEY');
  const bases = platformEnvList('SB_PLATFORM_BASE_URL');
  const i = Math.floor(Math.random() * Math.max(keys.length, bases.length));
  return { apiKey: keys[i] ?? '', baseUrl: bases[i] ?? '' };
}

/** 平台通道当前生效的默认模型名（**env > 常量**）——供设置页显示「一键默认会用哪个模型」。 */
export function platformDefaultModel(): string {
  return (process.env.SB_PLATFORM_MODEL ?? '').trim() || DEFAULT_PLATFORM_MODEL;
}

/**
 * 生图角色（`image`）的平台默认模型（**env > 常量**）。
 *
 * ★ 与 `platformDefaultModel()` **刻意分家，不许合并**：生图模型与聊天模型不同池——
 *   聊天默认是 `agnes-2.5-flash`（文本），拿它打 `/images/generations` 必 404/400。
 *   若共用一个兜底，`image` 角色在「绑定行 model 为空」时（一键默认设置正是这个态）
 *   会被静默填成聊天模型，症状是「零配置下生图必挂且报错里全是上游英文」。
 * ★ env `SB_IMAGE_MODEL` 是部署默认值（换生图模型改 env + 重启即可，不必碰数据）；
 *   常量兜底取平台聚合通道现役的生图模型。
 */
export const DEFAULT_IMAGE_MODEL = 'agnes-image-2.5-flash';

export function imagePlatformDefaultModel(): string {
  return (process.env.SB_IMAGE_MODEL ?? '').trim() || DEFAULT_IMAGE_MODEL;
}

/**
 * 该 provider 行**实际会用**的凭据（`env > 库`，且 env 只对平台行生效）。
 *
 * ★ 抽出来的理由：**"用哪把 key、打哪个地址"这条规则全仓只能有一份**。`routeRole` 发请求时
 *   要用它，`routes/providers.ts` 拉模型列表时也要用它——两处各写一遍的话，会出现
 *   「设置页能拉到模型，但真发请求却 401」这类只差一行的幽灵（v39 线上就是这样：
 *   平台行的 `api_key` 恒空，谁忘了走 env 谁就拿到空串）。
 *
 * ★★ **绝不可回给前端**：「一键配置后 key 是用户不可见的，也无法通过其他手段
 *   获取」。本函数是服务端内部用（拼上游请求 / 拉模型列表），返回值里带明文 key——
 *   任何路由都只许把它喂给 adapter，不许塞进 `res.json()`。平台行的 key 只存在于 env，
 *   数据库里那把永远是空的，这是"拖库也拿不到"的结构性保证。
 */
export function resolveProviderCredentials(p: {
  api_key: string;
  base_url: string;
  owner_id: string | null;
}): { apiKey: string; baseUrl: string } {
  // ★ 只对平台行注入 env。BYOK 行（用户自己的 provider）**绝不能**被 env 覆盖——
  //   那会把用户自己的 key 换成一笔平台开销，等于"你配了 key，但花的还是平台的钱"。
  const isPlatform = p.owner_id === null;
  // ★ 2026-10-02：一次取**主力那一对**（key[0] ↔ base[0]，按位配对），不再是"随机一路"。
  //   换路由 `upstream-failover.ts` 在适配器层完成（仅在平台行），这里只负责"第一发打哪一路"。
  const { apiKey: envKey, baseUrl: envBase } = isPlatform
    ? platformEnvPair()
    : { apiKey: '', baseUrl: '' };
  return { apiKey: envKey || decryptSecret(p.api_key), baseUrl: envBase || p.base_url };
}
