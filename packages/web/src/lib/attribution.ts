/**
 * lib/attribution — 「谁带来的」这一维的**前端那一半**（渠道台账 C4/C1，契约 `docs/GROWTH-SPEC.md` §2.5）。
 *
 * ★★ 为什么需要它：站内一跳之后 referer 就变成 `11wand.com` 自己，所以从贴吧／班级群／词条页
 *   点进来的人，第二跳起在服务端**再也认不出是谁带来的**。2026-09-24 的线上取证正是这样：
 *   当天 12 个 `app_open` 桶没有一个查得出来源。⇒ 靠 URL 上一个 `?ref=` 把渠道名送进来、
 *   存住、之后每个请求带回来，是这件事唯一不需要第三方统计的解法。
 *
 * ★ 三条口径（老板 2026-09-24 拍板，与契约同批成文）：
 *   1. **末触**：URL 上带了新的 ref 就覆盖旧值。测的是「这一次是谁带来的」，
 *      首触会让一个月前贴吧那条链接永久盖住今天的班级群。
 *   2. **不设白名单**：任何合规 slug 都收（字符集与长度仍要限，见 `normalizeRef`），
 *      否则每开一条渠道都要改一次代码＋重发版。
 *   3. ⚠️ **只存渠道名**：不存整条 URL、不存 `utm_content`／`gclid` 那类可能带个体标识的值，
 *      也不发给任何第三方。localStorage 里那一格最多 24 个字符。
 */

/** 与 `server/src/growth/counters.ts` 的 `REF_HEADER` 同一把头（那边读、这边写）。 */
export const REF_HEADER = 'X-SB-Ref';

/** localStorage 的键。改名等于把历史归因全部作废，所以它和契约一样要显式维护。 */
export const REF_STORAGE_KEY = 'sb_ref';

/** 认这两个参数名：`ref` 是本站公开页自己写的，`utm_source` 是外部投稿/发帖时惯用的那一个。 */
export const REF_PARAMS = ['ref', 'utm_source'] as const;

/** 与归一化函数成对出现：超过这个长度直接截断（表里那一格也是 24，两侧同值由测试锁住）。 */
export const REF_MAX_LEN = 24;

/**
 * 归一化任意来源串：小写、只留 `[a-z0-9_-]`（其余连续字符折成一个 `-`）、去首尾分隔符、截到 24。
 *
 * ★ 为什么客户端先归一遍而不是全交给服务端：发出去的头部值应当**已经是**表里能放的样子。
 *   否则用户贴一条带中文与空格的链接，浏览器会先在 `setRequestHeader` 上抛 `InvalidCharacterError`
 *   ——那是个把「渠道名里有中文」变成「整个页面请求全红」的错法。
 * ⚠️ 全非法（如纯中文 `贴吧`）⇒ 归一后是空串 ⇒ **不写存储、不发头**，这条流量落进 `direct`。
 *   宁缺不误归属：把"贴吧"洗成 `--` 之类再存进去，等于凭空造一个没人认领的渠道名。
 */
export function normalizeRef(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, REF_MAX_LEN);
}

/**
 * 从「地址栏能带的两处查询串」里取渠道名：先 `?a=1` 那一段，再 hash 里的 `#/pk?ref=x`。
 *
 * ★ 为什么要看 hash：本站是**顶层 hash 路由**（`main.tsx`），PK 邀请链接的形状就是
 *   `#/pk?code=…`。有人把分享链接写成 `11wand.com/#/?ref=tieba` 时，只看 `search` 会漏。
 */
export function extractRef(search: string, hash: string): string {
  for (const qs of [search, hash.includes('?') ? hash.slice(hash.indexOf('?')) : '']) {
    if (!qs) continue;
    const p = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
    for (const name of REF_PARAMS) {
      const v = normalizeRef(p.get(name));
      if (v) return v;
    }
  }
  return '';
}

/** 存储的最小面（`Storage` 的这一些），为了测试能喂一个内存对象而不是 jsdom。 */
export interface RefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 一次页面装载的归因：读到 ref 就**覆盖**存储（末触），读不到就沿用存储里的旧值。
 * 返回值是当前生效的渠道名（空串＝没有）。
 *
 * ⚠️ 存储写不进去（隐私模式下 `setItem` 会抛）时**不抛**：这一路最坏的代价是本次会话不再带
 *   来源，而不是页面打不开。与 `counters.ts` 那句「记账永不抛」是同一条纪律的两端。
 */
export function captureRef(loc: { search: string; hash: string }, store: RefStore | null): string {
  const fresh = extractRef(loc.search, loc.hash);
  if (fresh) {
    try {
      store?.setItem(REF_STORAGE_KEY, fresh);
    } catch {
      /* 存不下就用本次读到的值，不外溢成错误 */
    }
    return fresh;
  }
  try {
    return normalizeRef(store?.getItem(REF_STORAGE_KEY));
  } catch {
    return '';
  }
}

let captured: string | null = null;

/**
 * 当前生效的渠道名（空串＝没有）。★ **首次调用时才装载期归因**：
 * 这样不依赖「谁先 import」的顺序——`/api/auth/providers` 正是 `app_open` 的采集点，
 * 如果把时机交给 `main.tsx` 的 import 顺序，将来有人调一行 import 就会静默丢掉归因。
 */
export function currentRef(): string {
  if (captured !== null) return captured;
  if (typeof window === 'undefined') return '';
  let store: RefStore | null = null;
  try {
    store = window.localStorage;
  } catch {
    store = null; // 隐私模式／被禁用：只丢归因，不丢页面
  }
  captured = captureRef({ search: window.location.search, hash: window.location.hash }, store);
  return captured;
}

/** 测试用：一个装载周期跑一次，模块级缓存要能清（同 `resetDemoLoginLimits` 那一类）。 */
export function __resetRefForTests(): void {
  captured = null;
}
