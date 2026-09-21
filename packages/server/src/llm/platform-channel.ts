/**
 * llm/platform-channel — 平台免费通道的**服务端侧**：落点 provider、凭据、默认模型。
 *
 * ★ 与 `@sb/shared/platform-channel` 的分工（**别混，同名不同层**）：
 *   · 那边（shared）放**前后端共用**的常量（`DEFAULT_PLATFORM_PROVIDER_ID` /
 *     `DEFAULT_PLATFORM_MODEL`）——前端要显示「一键默认会用哪个模型」也读得到；
 *   · 本文件放**只有服务端能碰**的东西——env 里的凭据、数据库里的落点行。
 *     `resolveProviderCredentials()` 的返回值**带明文 key**，禁令写在它自己的注释里。
 *
 * ★ 为什么从 `router.ts` 拆出来（2026-09-21）：v39（零配置）与 v39.1（双入口随机）两个批次
 *   都往 `router.ts` 加东西，该文件撞到 `server/.ts ≤ 400` 红线（413 行）。本仓约定
 *   「**拆文件优先于压注释**」，故把「凭据怎么解析」整块搬出——它本来就是一个独立关注点：
 *   `router.ts` 关心「**哪个角色**用哪个 provider」，本文件关心「那个 provider 到底
 *   **拿哪把 key、打哪个地址、用什么模型名**」。两者都改的批次（正是 v39.1）就撞在一起。
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
 * 平台通道的 env 注入（v39「零配置」，2026-09-21 老板拍板）。
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────────
 * `seedIfEmpty` 的注释写着「apiKey 留空待用户填，开箱不 500」——那是**给自带 key 的用户**
 * 设计的开箱路径。老板现在要的是另一种开箱：**用户什么都不用配，直接用平台的额度**。
 * 两者不冲突，靠本函数区分：**平台行的凭据优先从 env 取**。
 *
 * ── 为什么走 env 而不是把 key 写进数据库 ──────────────────────────────────
 * ① **不让用户看到**（老板原话）。`getProviders()` 会把平台行回给前端（`ownerId: null`），
 *    而它本来就不返回 `api_key` 字段——把 key 留在 env ⇒ **数据库里那把 key 永远是空的**，
 *    任何 SQL 注入/拖库/接口泄漏都拿不到它。写进库则多一份可被读到的副本。
 * ② env 是**部署配置**，不该变成数据。写进库就有了两个真相源（改 env 不生效、改库不持久）。
 * ③ 轮换 key 只需改 env + 重启，不必碰数据。
 *
 * ── 三条各自的兜底语义（都不破坏既有行为）────────────────────────────────
 * · `SB_PLATFORM_API_KEY` 未配 ⇒ 回落数据库值（老部署 / BYOK 自建 provider 照常）；
 * · `SB_PLATFORM_BASE_URL` 未配 ⇒ 回落数据库值（线上现为 `https://api.openai.com/v1`，
 *   而老板实际用中转 ⇒ **部署时必须显式配这一条**，否则零配置会打到一个用不了的地址）；
 * · `SB_PLATFORM_MODEL` 未配 ⇒ 回落 `DEFAULT_PLATFORM_MODEL`（`@sb/shared/platform-channel`）。
 *   ★ 2026-09-21 从"回落绑定表的 model"改成"回落常量"：老板要的「一键默认设置」把绑定行的
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

/**
 * v39.1 双入口随机（2026-09-21，老板拍板「两个都要，随机分配」）：
 * `SB_PLATFORM_API_KEY`／`SB_PLATFORM_BASE_URL` 支持**逗号分隔多路**，按位配对
 * （key[i] ↔ base[i]）后**每次调用随机挑一路**。单值行为不变（长度 1 的列表随机＝恒取它）。
 * ★ 配对规则＝`min(keys, bases)`：两列表长度不等时**多出的路数无效**——宁可少一路，
 *   也不许出现「key 与地址错配」的合法假象（错配必然打向不属于这把 key 的入口）。
 * ★ 单边多值（只配多把 key、地址未配）⇒ 只对**有值的那条**随机，另一条仍回落数据库
 *   （v39 的逐条独立回落语义保持不变）。★ `SB_PLATFORM_MODEL` 仍单值，多路共享同一个模型名。
 */
function platformEnvPair(): { apiKey: string; baseUrl: string } {
  const keys = platformEnvList('SB_PLATFORM_API_KEY');
  const bases = platformEnvList('SB_PLATFORM_BASE_URL');
  if (keys.length === 0 || bases.length === 0) {
    const i = Math.floor(Math.random() * Math.max(keys.length, bases.length));
    return { apiKey: keys[i] ?? '', baseUrl: bases[i] ?? '' };
  }
  const i = Math.floor(Math.random() * Math.min(keys.length, bases.length));
  // ★ min 配对保证 i 在两侧界内，但 noUncheckedIndexedAccess 不知道——用 `?? ''` 兜给编译器看
  return { apiKey: keys[i] ?? '', baseUrl: bases[i] ?? '' };
}

/** 平台通道当前生效的默认模型名（**env > 常量**）——供设置页显示「一键默认会用哪个模型」。 */
export function platformDefaultModel(): string {
  return (process.env.SB_PLATFORM_MODEL ?? '').trim() || DEFAULT_PLATFORM_MODEL;
}

/**
 * 该 provider 行**实际会用**的凭据（`env > 库`，且 env 只对平台行生效）。
 *
 * ★ 抽出来的理由：**"用哪把 key、打哪个地址"这条规则全仓只能有一份**。`routeRole` 发请求时
 *   要用它，`routes/providers.ts` 拉模型列表时也要用它——两处各写一遍的话，会出现
 *   「设置页能拉到模型，但真发请求却 401」这类只差一行的幽灵（v39 线上就是这样：
 *   平台行的 `api_key` 恒空，谁忘了走 env 谁就拿到空串）。
 *
 * ★★ **绝不可回给前端**：老板明确要求「一键配置后 key 是用户不可见的，也无法通过其他手段
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
  // ★ v39.1：一次取一对（key[i] ↔ base[i] 按位配对），保证随机挑中的 key 与地址属于同一路。
  const { apiKey: envKey, baseUrl: envBase } = isPlatform
    ? platformEnvPair()
    : { apiKey: '', baseUrl: '' };
  return { apiKey: envKey || decryptSecret(p.api_key), baseUrl: envBase || p.base_url };
}
