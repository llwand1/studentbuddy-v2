/**
 * growth/counters — 诚实计数的**唯一写入口**（渠道台账 C4，契约 `docs/GROWTH-SPEC.md` §2）。
 *
 * ★★ 本模块存在的理由是一件容易做错的事：**数从哪里记，决定了这个数能不能信。**
 *   计数只写在 **HTTP 入口层**（调用点全在 `routes/`），不写在领域函数里。这不是风格偏好，
 *   是三条实打实的后果：
 *   ① 体验号的**八条种子内容**走的是 `saveOneTerm`（`auth/demo-seed.ts`），一个 HTTP 请求都不经过
 *      ⇒ **结构上进不了这份账**，不需要「记得把种子排除」；
 *   ② 探针流量带 `X-SB-Probe`／`studentbuddy-probe/*` UA（批次 E 的 C10 打标），本模块在写入口
 *      一处判掉 ⇒ `_probe/prod-pulse.mjs` 每几分钟一次的 demo-login **不会再灌爆体验号计数**；
 *   ③ 真实用户的动作与「脚本造出来的动作」在**写入侧**就分开了，读侧拿到的数不需要理由就能报。
 *
 * ★ 三条不变式（都在 `counters.test.ts` 有锁）：
 *   · **同一来源 IP 同一自然日只算一次**（判据原文，靠 `PRIMARY KEY (kind, bucket, day)` ＋ `INSERT OR IGNORE`）；
 *   · **不落裸 IP**：桶是 `sha256(盐 + IP)` 前 16 位，盐在同库里稳定（`growth_secret`，见迁移 v41 为什么不用环境变量）；
 *   · ★ **记账永远不抛**：本模块挂在登录与启动路径上，计数是旁路观测，
 *     它坏了一次的代价应该是「少个数」，不该是「进不去应用」。
 */
import { createHash } from 'node:crypto';
import { localDayKey } from '@sb/shared';
import { getDb } from '../storage/db.js';

/** 三种真实动作（★ 刻意不含「词条被写入」：那条要走 owner 维度，与这里的 IP 桶不同单位，混进一张表就是混两种口径）。 */
export const GROWTH_ACTIONS = ['app_open', 'demo_enter', 'register_done'] as const;

export type GrowthAction = (typeof GROWTH_ACTIONS)[number];

/**
 * 单位与口径。⚠️ **只许写「次」，不许写「人」**（总口径 §0 第 2 条：现有设施算不出 UV，
 * 原始 `hits` 表 0 行）——`unit` 与 `unitLabel` 随响应体一起出去，就是为了让
 * 「将来谁来显示」都拿得到这句话是怎么算的，而不是只拿到一个光秃秃的整数。
 */
export const GROWTH_UNIT = 'ip_day';
export const GROWTH_UNIT_LABEL = '次（同一来源 IP 当天只算一次）';

/** 批次 E 打好的两个标记（`_probe/probe-marker.mjs` 发 UA ＋ 请求头），本模块**照原样认**。 */
export const PROBE_HEADER = 'x-sb-probe';
export const PROBE_UA_PREFIX = 'studentbuddy-probe/';

/**
 * 只声明本模块真正要读的两样，不 import express 的 `Request`：
 * 这样测试可以直接喂字面量，而调用点传 `req` 一样过（结构化类型）。
 */
export interface GrowthRequestLike {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** 请求头可能被 Node 解析成数组（重复头），两值都要判，不能只判 string。 */
function headerValue(value: string | string[] | undefined): string {
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === 'string' ? one : '';
}

/**
 * 这条请求是**我们自己造的**吗（C10）？
 *
 * ★ 两个通道各判各的，**任一条命中就算探针**：UA 进 Caddy 日志、请求头进应用——
 *   将来加新探针时可能只带其中一个（`curl` 就只能带 UA），所以不做「两个都要有」。
 * ⚠️ 反过来刻意**不**按「UA 不在白名单就剔掉」处理：那会把真人少计（老旧浏览器、无 UA 的读屏器）。
 *   判据是「认得出自己」，不是「认不出别人」。
 */
export function isProbeRequest(req: GrowthRequestLike): boolean {
  if (headerValue(req.headers[PROBE_HEADER]).trim() !== '') return true;
  return headerValue(req.headers['user-agent']).toLowerCase().startsWith(PROBE_UA_PREFIX);
}

/**
 * 盐从库里读、**刻意不做模块级缓存**：本仓的库在测试与运行期会被换（`openIsolated`／`closeDb`），
 * 缓存会让下一座库拿着上一座库的盐算桶——那种错不会有任何报错，只会让去重悄悄失效。
 * 一行 `SELECT` 的成本，比这个风险便宜。
 */
function readSalt(): string {
  const row = getDb().prepare('SELECT salt FROM growth_secret LIMIT 1').get() as { salt: string } | undefined;
  if (!row) throw new Error('growth_secret 缺行（迁移 v41 未应用？）');
  return row.salt;
}

/** 桶：`sha256(盐|IP)` 前 16 位。16 位十六进制＝64 bit，本表量级下碰撞可忽略，而明文 IP 不该留。 */
export function growthBucket(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 16);
}

/**
 * 记一次动作。返回 `true` ＝ 今天第一次见到这个桶（写进去了一行），`false` ＝ 已被去过或是探针。
 *
 * ⚠️ `ip` 为空串的处置：**照记不误**。生产未配 `SB_TRUST_PROXY=1` 时 `req.ip` 恒为反代自身地址
 *   （同 `routes/auth.ts` 的 `clientIp` 注释），后果是**全站塌成每天一次**——那是**少计**，
 *   方向安全（宁可少报也不谎报），但它会在发版后被当成「没人来」，所以口径写进 GROWTH-SPEC §4：
 *   上线第一天必须核 `app_open` 是否 >1，否则先修配置再看数。
 */
export function recordGrowthAction(action: GrowthAction, req: GrowthRequestLike): boolean {
  try {
    if (isProbeRequest(req)) return false;
    const salt = readSalt();
    const bucket = growthBucket(req.ip ?? '', salt);
    const day = localDayKey(new Date());
    const info = getDb()
      .prepare(
        `INSERT OR IGNORE INTO growth_action_day (kind, bucket, day, first_seen_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(action, bucket, day);
    return info.changes > 0;
  } catch (e) {
    // ★ 旁路观测不许变成故障源：这里只 warn，不抛（见头注不变式③）
    console.warn('[sb-growth] 记账失败（不影响本次请求）:', e instanceof Error ? e.message : e);
    return false;
  }
}

export interface GrowthSnapshot {
  counts: Record<GrowthAction, number>;
  /** 见 `GROWTH_UNIT_LABEL`——数字与它的算法必须一起出门。 */
  unit: string;
  unitLabel: string;
  /** 表里最早的一天（还没有任何数时为 `null`，★ 不是 1970-01-01 那种假默认）。 */
  firstDay: string | null;
}

/**
 * 读侧快照：三种动作各自的「IP·天」数。
 *
 * ★ **零填充在 SQL 之外做**（`GROWTH_ACTIONS` 是唯一的键表）：`GROUP BY` 出来的行只含非零项，
 *   少了这一步，读侧就得到「缺键」而不是「0」——而缺键在上层极易被当成 0 之外的事实源。
 * ⚠️ 真实计数为 0 时本模块**不造任何兜底数字**（判据：「计数为 0 时页面不许显示假数」，见 GROWTH-SPEC §3）。
 */
export function readGrowthSnapshot(): GrowthSnapshot {
  const rows = getDb()
    .prepare('SELECT kind, COUNT(*) AS c FROM growth_action_day GROUP BY kind')
    .all() as Array<{ kind: string; c: number }>;
  const byKind = new Map(rows.map((r) => [r.kind, r.c]));
  const counts = {} as Record<GrowthAction, number>;
  for (const action of GROWTH_ACTIONS) counts[action] = byKind.get(action) ?? 0;
  const first = getDb().prepare('SELECT MIN(day) AS d FROM growth_action_day').get() as { d: string | null };
  return { counts, unit: GROWTH_UNIT, unitLabel: GROWTH_UNIT_LABEL, firstDay: first.d };
}
