/**
 * platform-env-check — 「零配置平台通道」接线验收探针（v39，2026-09-21）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 老板拍板「api 改成默认零配置、用我的 key、每 5 小时 250 次、不让用户看到」之后，
 * 平台凭据改从 env 读（`SB_PLATFORM_API_KEY` / `_BASE_URL` / `_MODEL`），数据库里那把 key
 * **永远是空的**。代价是：**这三个值不配 = 全站 AI 完全不可用**，而症状是
 * 「该角色还没绑定模型」——**看起来像用户自己没设置**（`launch-plan` §3.2 第 5 项专门警告过）。
 *
 * 所以在把 key 交给运维之前，需要能回答一个确定的问题：
 * **「这三个值写进去 + 重启，八个角色会不会真的就绪？」**
 * 单测能证明 `routeRole` 的回落链，但证明不了**部署产物上**、**用真实那份库**、**八个角色**
 * 逐个都翻得过来；而等 key 到了才发现接线有问题，就得多跑一轮发布。
 *
 * ── 它走产品代码，不复现实现 ──────────────────────────────────────────────
 * 直接 `import` 产品的 `routeRole` / `roleReady` / `MODEL_ROLES`（`packages/server/src/llm/router.ts`），
 * 空库时调一次产品自己的 `seedIfEmpty()` 复现线上形态（平台行 + 八行空 `model` 绑定）。
 * 同 `_probe/vision-e2e` 的口径。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────
 *   # ⓪ 先造一份**生产库副本**（只读；本仓 `_probe/` 已被 gitignore，正是给库副本用的）
 *   sqlite3 /opt/studentbuddy/data/studentbuddy.db ".backup _probe/data-platform-env/studentbuddy.db"
 *
 *   # ① 只看接线（不需要真 key，零网络请求）
 *   npx tsx tools/probes/platform-env-check.mjs
 *   #   （SB_DATA_DIR 缺省取 `_probe/data-platform-env`）
 *
 *   # ② 带真 key 打一发真实上游（只读 /models，**不消耗 token**）
 *     ★ v39.1 起 KEY／BASE_URL 支持逗号分隔多路（按位配对）——--live 会**逐路**各打一发。
 *   SB_PLATFORM_API_KEY=sk-xxx SB_PLATFORM_BASE_URL=https://xxx/v1 SB_PLATFORM_MODEL=xxx \
 *     npx tsx tools/probes/platform-env-check.mjs --live
 *
 *   # ③ 换库副本位置
 *   SB_DATA_DIR=/path/to/dir npx tsx tools/probes/platform-env-check.mjs
 *
 * ★ 必须用 `npx tsx` 跑（本探针 import 产品的 `.ts` 源码；仓内其他 `tools/probes/*.mjs`
 *   是零依赖 CDP 探针、用 `node` 跑即可，两者不同）。
 * ★ 本文件**刻意用 `.mjs` 而不是 `.ts`**：同目录若写成 `.ts`，tsx 会把它当 CJS，
 *   顶层 await 直接报 `Top-level await is currently not supported with the "cjs" output format`
 *   （本仓 `_probe/vision-e2e.mts` 踩过一次，这是第二次）。
 *
 * ── 2026-09-21 实测基线（本地 + 线上部署产物 + 生产库副本，三处都跑过）────────
 *   · 不带 `SB_PLATFORM_*` ⇒ **0 / 8 就绪**，理由全是「该角色还没绑定模型」、
 *     `apiKey=(空)`、`baseUrl=https://api.openai.com/v1`（＝库里的值）；
 *   · 带三个值 ⇒ **8 / 8 就绪**，`apiKey` 取 env、`baseUrl` 被 env 顶掉、`model` 取 env，
 *     而数据库那行 `key_len` **仍是 0** ⇒ 「key 只走 env、不落库」由结构保证；
 *   · `--live` 无 key 时**正确跳过**（不会假装验过）。
 *
 * ── 边界（按本仓 ADR-6：不碰用户数据）────────────────────────────────────
 * · **只读**：`SB_DATA_DIR` 必须显式指向隔离目录（缺省 `_probe/data-platform-env`，
 *   且**拒绝**在未给 `SB_DATA_DIR` 时去连默认数据目录）；
 * · 除 `--live` 外**不发任何网络请求**；
 * · key 只打印**脱敏**形态（头 6 尾 4 + 长度），不落原文。
 */
import { initCrypto } from '../../packages/server/src/storage/crypto.js';
import { openIsolated } from '../../packages/server/src/storage/db.js';
import { MODEL_ROLES, roleReady, routeRole, seedIfEmpty } from '../../packages/server/src/llm/router.js';

const LIVE = process.argv.includes('--live');
const DEFAULT_DIR = '_probe/data-platform-env';

function mask(v) {
  if (!v) return '(空)';
  if (v.length <= 8) return `${v.slice(0, 2)}***（len=${v.length}）`;
  return `${v.slice(0, 6)}***${v.slice(-4)}（len=${v.length}）`;
}

function envLine(name, fallback) {
  const v = (process.env[name] ?? '').trim();
  return `  ${name.padEnd(24)} = ${v ? mask(v) : `(未配 ⇒ 回落${fallback})`}`;
}

// v39.1：KEY/BASE_URL 支持逗号分隔多路，展示时逐路脱敏
function splitEnvList(name) {
  return (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
function envListLine(name, fallback) {
  const list = splitEnvList(name);
  if (list.length === 0) return `  ${name.padEnd(24)} = (未配 ⇒ 回落${fallback})`;
  return `  ${name.padEnd(24)} = [ ${list.map((v, i) => `#${i}:${mask(v)}`).join("  ")} ]`;
}

const dir = (process.env.SB_DATA_DIR ?? '').trim() || DEFAULT_DIR;
initCrypto();
const db = openIsolated(dir);
seedIfEmpty();

console.log(`[platform-env-check] 库副本目录 = ${dir}`);
console.log('\n=== 环境（脱敏）===');
console.log(envListLine('SB_PLATFORM_API_KEY', '数据库 api_key'));
console.log(envListLine('SB_PLATFORM_BASE_URL', '数据库 base_url'));
console.log(envLine('SB_PLATFORM_MODEL', '角色绑定 model'));

console.log('\n=== 平台 provider 行（owner_id IS NULL）===');
const rows = db
  .prepare(
    `SELECT id, name, type, base_url, length(coalesce(api_key,'')) AS key_len, enabled
       FROM providers WHERE owner_id IS NULL ORDER BY created_at`,
  )
  .all();
if (rows.length === 0) console.log('  （无平台 provider ⇒ 所有角色都会报「没有启用的服务商」）');
for (const r of rows) {
  console.log(`  ${r.id} | ${r.name} | type=${r.type} | enabled=${r.enabled} | key_len=${r.key_len} | ${r.base_url}`);
}

console.log('\n=== 八个角色逐个解析（requester = null，即免费通道）===');
let readyCount = 0;
for (const { role, label } of MODEL_ROLES) {
  const t = routeRole(role, undefined, null);
  const ready = roleReady(role, null);
  if (ready.ok) readyCount++;
  if (!t) {
    console.log(`  ${role.padEnd(16)} ${label.padEnd(6)} ⇒ 无可用目标（${ready.reason}）`);
    continue;
  }
  console.log(
    `  ${role.padEnd(16)} ${label.padEnd(6)} ⇒ adapter=${t.adapter.type} model=${t.model || '(空 ⚠️)'} ` +
      `apiKey=${mask(t.apiKey)} baseUrl=${t.baseUrl} ready=${ready.ok}${ready.ok ? '' : ` reason=${ready.reason}`}`,
  );
}
console.log(`\n  小结：${readyCount} / ${MODEL_ROLES.length} 个角色就绪`);

if (readyCount < MODEL_ROLES.length) {
  console.log('  ⇒ 未就绪的原因链：`roleReady` 只判「有没有目标」与「model 是否为空」。');
  console.log('     model 为空的常见根因＝`role_bindings.model` 为空且 `SB_PLATFORM_MODEL` 也没配。');
}

if (LIVE) {
  console.log('\n=== --live：真实上游（只打 /models，不消耗 token）===');
  // v39.1：KEY/BASE_URL 支持逗号分隔多路 ⇒ 按位配对**逐路**验证（随机分配的每一口都得通）
  const keys = splitEnvList('SB_PLATFORM_API_KEY');
  const bases = splitEnvList('SB_PLATFORM_BASE_URL');
  const envModel = (process.env.SB_PLATFORM_MODEL ?? '').trim();
  const routes =
    keys.length > 0 && bases.length > 0
      ? Array.from({ length: Math.min(keys.length, bases.length) }, (_, i) => ({
          apiKey: keys[i],
          baseUrl: bases[i],
        }))
      : [];
  if (routes.length === 0) {
    const t = routeRole('coach', undefined, null); // 老口径：env 未按多路配 ⇒ 只验解析出的那一条
    if (t) routes.push({ apiKey: t.apiKey, baseUrl: t.baseUrl });
  }
  if (routes.length === 0) console.log('  跳过：env 与数据库都没有解析出可用目标');
  const anyTarget = routes.length > 0 ? routeRole('coach', undefined, null) : null; // 只为拿 adapter
  for (const [idx, r] of routes.entries()) {
    console.log(`\n  -- 第 ${idx + 1} 路 --`);
    if (!r.apiKey) {
      console.log('  跳过：该路 apiKey 为空（env 与数据库都没有 key）');
      continue;
    }
    const url = `${r.baseUrl.replace(/\/+$/, '')}/models`;
    console.log(`  GET ${url}`);
    const t0 = Date.now();
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${r.apiKey}` } });
      const body = await res.text();
      console.log(`  裸 fetch：status=${res.status} 耗时=${Date.now() - t0}ms`);
      console.log(`  响应前 240 字：${body.slice(0, 240)}`);
      if (res.status === 401 || res.status === 403) {
        console.log('  ⇒ 可达但**凭据被拒**：key 不对、或该 key 不属于这个 base_url');
      } else if (res.ok) {
        console.log('  ⇒ ✅ 可达且凭据有效');
      }
    } catch (err) {
      console.log(`  裸 fetch 网络失败：${err instanceof Error ? err.message : String(err)}`);
      console.log('  ⇒ 服务器连不上这个 base_url（线上出口在美国；若用国内中转需确认对海外 IP 开放）');
    }
    // ★ 再走一遍**产品代码**：上面裸 fetch 给的是 HTTP 状态，这里给的是「产品实际会拿到什么」
    if (!anyTarget) continue;
    const models = await anyTarget.adapter.listModels({ baseUrl: r.baseUrl, apiKey: r.apiKey });
    console.log(
      `  产品 listModels() 返回 ${models.length} 个模型${models.length ? '：' + models.slice(0, 6).join(', ') : '（空 ⇒ 按上面的 status 定位）'}`,
    );
    const wantModel = envModel || anyTarget.model;
    if (models.length > 0) {
      console.log(`  目标模型「${wantModel}」在清单里：${models.includes(wantModel) ? '是 ✅' : '否 ⚠️（模型名可能写错）'}`);
    }
  }
}
process.exit(0);
