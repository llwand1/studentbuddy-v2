/**
 * shared/platform-channel — 平台免费通道的**非配额**常量（2026-09-21 老板拍板「一键默认设置」）。
 *
 * ── 为什么单开一个文件而不是塞进 `platform-quota.ts` ────────────────────────
 * 那份文件的头一行就写明「本文件只放**配额**的常量与形状」。默认模型名、种子 provider id
 * 都不属于配额——它们描述的是**平台通道本身长什么样**。塞进去会让「改配额口径」和
 * 「换默认模型」这两件毫不相干的事挤在同一个 diff 里。
 *
 * ── `DEFAULT_PLATFORM_MODEL` 为什么是**兜底**而不是真相源 ────────────────────
 * 平台通道的模型优先级链（见 `server/src/llm/router.ts`）是：
 *   **角色绑定表 `role_bindings.model` > 环境变量 `SB_PLATFORM_MODEL` > 本常量**
 * 本常量只在**两者都没给**时兜底，作用是「哪怕运维忘了配 env，零配置也不至于退化成
 * `该角色还没绑定模型`」。★ 老板要改全站默认模型时改 **env**（改完重启即生效、不必碰数据）；
 * 若把它硬写进 8 条绑定行，env 就再也盖不动它了（绑定优先级更高）——那正是本仓反复强调的
 * 「同一事实写两遍」的坑。
 *
 * ── baseUrl 为什么不在这里给默认值 ─────────────────────────────────────────
 * 平台通道的地址链是 **`SB_PLATFORM_BASE_URL` > 数据库 `providers.base_url`**，而种子行
 * 里写的是 `https://api.openai.com/v1`（那是给 BYOK 用户的开箱占位，不是平台真实上游）。
 * `agnes-2.5-flash` 属于 agnes 中转站，实测两个候选地址**从生产服务器都可达**
 * （均返 401 = 存在且需鉴权，都在 Cloudflare 之后）：
 *   · `https://api.agnes-ai.cn/v1`      —— 国内域名
 *   · `https://apihub.agnes-ai.com/v1`  —— 国际域名（生产机在美西，出口直达）
 * **哪个是真上游由 key 决定，代码猜不出来** ⇒ 不在常量里编一个默认值（编错会让零配置
 * 打到一个"能连上但鉴权不通过"的地址，报错信息还指向 key，把人带偏）。运维配 env 时一并给。
 */

/** 种子平台 provider 的 id（`seedIfEmpty()` 写入的那个）。多处硬编码过，这里收成一处。 */
export const DEFAULT_PLATFORM_PROVIDER_ID = 'openai-default';

/** 平台通道的兜底模型名（`SB_PLATFORM_MODEL` 未配时生效）。 */
export const DEFAULT_PLATFORM_MODEL = 'agnes-2.5-flash';
