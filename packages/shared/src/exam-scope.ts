/**
 * exam-scope — 应试模式「范围」的地基：域名归一化、命中判定、缓存签名（纯函数，两侧共用）。
 *
 * 为什么要有这一层（老板 2026-10-04 指示 EXAM-1004）：出题质量与资源质量的根因是**来源不设界**——
 * 免 key 通道什么域都返，抓回来的多半是百科/新闻/JS 壳页。应试模式把「资料与题库只从用户指定的站内搜集」
 * 做成硬闸，而闸的判据只有这一份文件能定义（服务端过滤、缓存键、Web 端展示都从这里走，避免两套口径）。
 *
 * ★ 域匹配是**后缀式**的：登记 `eol.cn` 会连 `gaokao.eol.cn` 一起放行，登记 `jyeoo.com` 放行
 *   `www.jyeoo.com`，但 `xjyeoo.com` **不**匹配（比较用 `.${host}` 结尾，不是 `includes`）。
 *   这条判据被 `exam-scope.test.ts` 锁着——写成 includes 会把仿冒域放进来。
 */

/** 题源等级：question=实测能直达题目页（有站内检索端点或实测含题形）；reference=只作资料 */
export type ExamSourceTier = 'question' | 'reference';

/** 站内检索端点：`search` 里 `{q}` 是查询词占位（替换时由调用方 encodeURIComponent） */
export interface ExamDirectEndpoint {
  search: string;
  /** 这条端点最后一次实测通过的日期（改版就靠它判断哪行过期） */
  verifiedAt: string;
}

export interface ExamSource {
  /** 归一化域：无协议、无路径、无 `www.` */
  host: string;
  /** 用户可见的站名 */
  label: string;
  tier: ExamSourceTier;
  /** 所属考试类目 id（见 exam-sources.ts 的 EXAM_PACKS） */
  packs: readonly string[];
  direct?: ExamDirectEndpoint;
  /** 实测读数——只写观察到的事实，不写「质量好」这类承诺 */
  note?: string;
}

export interface ExamPack {
  id: string;
  label: string;
  /** 一句话说明这一类包含什么，出现在设置页 */
  hint: string;
}

// ── app_settings 键 ──

/** 应试模式开关（boolean JSON） */
export const SETTING_KEY_EXAM_MODE = 'exam_mode';
/** 应试范围（`{ packs: string[]; custom: string[] }` JSON） */
export const SETTING_KEY_EXAM_SOURCES = 'exam_sources';

/** 缺省**关**：不开应试模式时，搜索/出题行为与今天逐字节一致（闸口全部旁路）。 */
export const DEFAULT_EXAM_MODE = false;

/** 用户自填域名上限：再多就不是「用户决定范围」，是把白名单维护活推给了用户 */
export const MAX_EXAM_CUSTOM_HOSTS = 24;
const MAX_EXAM_HOST_CHARS = 120;

export function normalizeExamMode(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (input === 'true' || input === 1 || input === '1') return true;
  if (input === 'false' || input === 0 || input === '0') return false;
  return DEFAULT_EXAM_MODE;
}

/**
 * 域名归一化：接受用户粘贴的「https://www.jyeoo.com/math/x」「JYEOO.COM。」等多种形式。
 * 非法一律返回 null（不抛、不猜），由调用方决定是丢弃还是报错。
 */
export function normalizeExamHost(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s || s.length > MAX_EXAM_HOST_CHARS) return null;
  // 允许带协议/路径的粘贴：只取主机名，其余丢掉
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host = '';
  try {
    host = new URL(s).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  // 必须是「点分隔的多段 + 至少两字母的尾缀」；挡掉 localhost、纯 IP、单段名、空段
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host)) return null;
  return host;
}

/** 主机名是否落在白名单内（后缀式：登记 `eol.cn` 放行 `gaokao.eol.cn`，但不放 `xeol.cn`） */
export function examHostAllowed(host: string, hosts: readonly string[]): boolean {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  for (const raw of hosts) {
    const e = normalizeExamHost(raw);
    if (!e) continue;
    if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** URL 是否落在白名单内（解析失败＝不允许，宁可漏一条真结果也不放一个坏 URL 进闸） */
export function examUrlAllowed(url: unknown, hosts: readonly string[]): boolean {
  if (typeof url !== 'string' || !url) return false;
  let host = '';
  let protocol = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/\.+$/, '');
    protocol = u.protocol;
  } catch {
    return false;
  }
  // ★ 协议也在闸内：只比主机名会让 `ftp://eol.cn`、`view-source://eol.cn` 这类"同一域的不同通道"
  //   被判成范围内（下游 fetchSafe 会挡，但那是别人的防线，本闸的承诺是「范围内＝站内可取的 http(s) 页」）。
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  return examHostAllowed(host, hosts);
}

/**
 * 带 url 的条目按白名单一刀两断：kept 进闸，dropped 计数要回给用户（「范围外已过滤 n 条」）。
 * ★ 空 `hosts` ＝ **全拦**，不是「不设界」。想不筛就别调这个函数（调用方传 `undefined`），
 *   把「空数组」当「放行一切」是一个会静默关掉闸门的默认值。
 */
export function splitByExamScope<T extends { url?: string }>(
  items: readonly T[],
  hosts: readonly string[],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const it of items) (examUrlAllowed(it.url, hosts) ? kept : dropped).push(it);
  return { kept, dropped };
}

/**
 * 范围签名：进 `search_cache` 的键。
 * ★ 少了它，A 用户的「全站命中」会被 B 用户的「窄范围查询」直接复用 24 小时（缓存串味），
 *   而且关/开应试模式两次查询拿到同一份结果——那等于白名单形同虚设。
 */
export function examScopeSignature(hosts: readonly string[]): string {
  const joined = scopeHosts(hosts).join(',');
  if (!joined) return 'all';
  let acc = 0x811c9dc5;
  for (let i = 0; i < joined.length; i += 1) {
    acc ^= joined.charCodeAt(i);
    acc = Math.imul(acc, 0x01000193) >>> 0;
  }
  return `w${acc.toString(36)}`;
}

/** 归一化＋去重＋排序：签名、比较、展示都用这一份，避免同一集合三种顺序 */
export function scopeHosts(hosts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const h of hosts) {
    const n = normalizeExamHost(h);
    if (n) out.add(n);
  }
  return [...out].sort();
}

/**
 * 一轮外部检索的**范围账**（进 `QuizSearchReport` / `CollectReport`，前端念给用户）。
 *
 * ★ 为什么必须回显而不是只在服务端记：白名单是用户选的，「范围内没找到真题」与
 *   「搜索挂了」是两条完全不同的行动（前者要扩范围，后者要重试）。
 *   不区分就会重演 2026-09-17 那次的口径事故——把内部配置细节甩给模型，模型转述成「我没有联网功能」。
 */
export interface ExamScopeReport {
  on: boolean;
  /** 范围一句话（`高考、中考＋2 个自填站`）；关时为空串 */
  summary: string;
  /** 落在范围内、真正进提示词的条数 */
  kept: number;
  /** 范围外被过滤掉的条数（用户可见：「已过滤 n 条」） */
  dropped: number;
  /** 走过站内直达的站名（一个都没走成 ⇒ 只剩通用搜索） */
  directSites: string[];
  /** 范围内一条都没拿到：UI 要明说「本套题为 AI 生成，范围内未取到真题」 */
  empty: boolean;
  /** 一个范围都没勾（hosts 空）：这与「范围内没搜到」是两条不同的行动，必须分开报 */
  hostsEmpty: boolean;
}

export function emptyExamScopeReport(on = false, summary = ''): ExamScopeReport {
  return { on, summary, kept: 0, dropped: 0, directSites: [], empty: false, hostsEmpty: false };
}
