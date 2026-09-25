/**
 * search/bing-channel — 免 key 搜索兜底通道（RSS 主 + HTML 兜底）与仓内唯一的 HTML→正文。
 *
 * 2026-09-25 从 `search/index.ts` 拆出（400 行红线，仓规「拆文件不压注释」），逻辑零改动；
 * 聚合层（`index.ts`）与外部消费者仍从 `search/index.js` 进（它 re-export 本文件的公开面），
 * 拆分的目的是让 Bing 这条**外部依赖**的形状知识待在自己那一格里。
 *
 * 通道形状史：
 * - 2026-09-17 换血：原 DDG 通道在本机网络直连超时、彻底不可用，改用 Bing 免 key 入口。
 * - 2026-09-25 换主机：`cn.bing.com/search` 的 301 开始丢掉 `/search` 路径（bug-ledger B-019
 *   / issue #11），详见 `BING_SEARCH` 处注释。
 */
import { fetchSafe } from './ssrf-guard.js';
import { combineSignals } from './combine.js';
import type { SearchResult } from './types.js';

const BING_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * ★ 这里**必须**是 www.bing.com，两个主机名在生产机上是反过来的（2026-09-25 两侧实测）：
 *   `cn.bing.com/search?q=…` 301 → `www.bing.com/?q=…`，**路径里的 /search 被丢掉**，
 *   跟随后拿到的是首页：RSS 通道 0 个 `<item>`、HTML 通道 0 个 `b_algo`，两路同时「空结果」
 *   ⇒ 免 key 部署的联网搜索整条哑掉，而且不报错（B-019 的病灶）。
 *   www 在境外出口直落 `/search`（生产机实测 RSS 10 条 `<item>`），在国内出口 302 → `cn.bing.com/search`
 *   （本机实测 9 条）——**跳板方向随出口 IP 变，只有 www 两头都能落到 SERP**，故钉 www。
 *   原先钉 cn 是因为当时在本机测得「www 会 302 到 cn，多一跳」，那是一条**随出口而变**的观测。
 * ⚠️ 外部依赖，不是本仓能锁住的不变量：主机名与跳转规则都可能再翻。故两通道各带「形状不符」
 *   的显式报错（见 `bingRss`/`bingHtml`），下次改版会说出「返回的不是 RSS」这种可定位的话，
 *   而不是与真·查无结果同框的「空结果」；定期打真请求的自检见 `tools/probes/bing-channel-live.mjs`。
 */
const BING_SEARCH = 'https://www.bing.com/search';

/** 码点还原：空白类实体（&#160; 等）归一为空格，非法码点丢弃。 */
function fromCodePoint(raw: string, radix: number): string {
  const n = Number.parseInt(raw, radix);
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  return n === 160 ? ' ' : String.fromCodePoint(n);
}

/** XML/HTML 实体还原（RSS 与 HTML 片段共用）。`&` 必须最后解，避免二次转义。 */
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => fromCodePoint(h, 16))
    .replace(/&#(\d+);/g, (_, d: string) => fromCodePoint(d, 10))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 剥标签 + 实体还原 → 纯文本（标题含 <strong> 高亮标签，必须走这一步）。
 *  导出供现场搜集复用（RESOURCE-SPEC §5 待核实①：仓内唯一 HTML→正文件，不再造第二个）。 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // 块级/换行标签留一个空格做分隔；行内标签（<strong> 高亮）直接删，避免把标题切碎
      .replace(/<\/?(?:br|p|div|li|ol|ul|h[1-6])\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** RSS 通道（主）：结构化、体积小（~8KB）、字段稳定，实测中文查询稳定出 10 条。 */
async function bingRss(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchSafe(`${BING_SEARCH}?q=${encodeURIComponent(query)}&format=rss`, {
    headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: combineSignals(signal, 6_000),
  });
  if (!res.ok) throw new Error(`Bing RSS ${res.status}`);
  const xml = await res.text();
  const results = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map((m) => {
      const block = m[1] ?? '';
      // 缺标签与空标签是两回事：`undefined` 与 `''` 在此不分家，但 `field()` 只在**有标签**时返回串，
      // 免得 `decodeEntities(undefined ?? '')` 把「没有 <link>」伪装成「<link> 是空串」。
      const field = (tag: string): string | undefined => {
        const hit = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
        return hit ? decodeEntities(hit[1] ?? '').trim() : undefined;
      };
      return {
        title: field('title') ?? '',
        url: field('link') ?? '',
        snippet: (field('description') ?? '').replace(/\s+/g, ' ').slice(0, 500),
        source: 'bing',
      };
    })
    .filter((r) => r.url.startsWith('http'));
  // ★ 形状不符要说话，不许静默成「空结果」（B-019）：0 条 <item> 且整篇不像 RSS 时，
  //   拿到的是别的页面（首页 / 同意页 / 反爬页），报「不是 RSS」才可定位。
  //   长得像 RSS 却零条目＝真·查无结果，照常返回空数组，交上层逐路降级。
  if (results.length === 0 && !/<rss[\s>]/i.test(xml)) {
    throw new Error(`Bing RSS 返回的不是 RSS（${describeResponse(res, xml.length)}）`);
  }
  return results;
}

/** HTML 通道（兜底）：RSS 端点若被关闭/改版时接管；按 b_algo 块切分后逐块取标题与摘要。 */
async function bingHtml(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchSafe(`${BING_SEARCH}?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: combineSignals(signal, 6_000),
  });
  if (!res.ok) throw new Error(`Bing HTML ${res.status}`);
  const html = await res.text();
  const blocks = html.match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<li class="b_pag"|<\/ol>)/gi) ?? [];
  const results = blocks
    .slice(0, 8)
    .map((block) => {
      const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const para =
        block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
        block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
      return {
        title: htmlToText(link?.[2] ?? ''),
        url: decodeEntities(link?.[1] ?? ''),
        snippet: htmlToText(para?.[1] ?? '').slice(0, 500),
        source: 'bing-html',
      };
    })
    .filter((r) => r.url.startsWith('http'));
  // 同上：连 `b_results` 这条结果区容器都没有，说明这不是一个 SERP 页，而是被改跳到了别的页面。
  if (results.length === 0 && !html.includes('b_results')) {
    throw new Error(`Bing HTML 页面无结果区（${describeResponse(res, html.length)}）`);
  }
  return results;
}

/** 形状异常时的现场描述：只报「最终落到了哪个页面的哪个路径」，查询词不进这条串。 */
function describeResponse(res: Response, bodyChars: number): string {
  const raw = typeof res.url === 'string' ? res.url : '';
  let where = '';
  try {
    const u = new URL(raw);
    where = `${u.host}${u.pathname}`;
  } catch {
    where = raw.slice(0, 60) || '未知';
  }
  return `HTTP ${res.status}、${bodyChars} 字符、最终落在 ${where}`;
}

/** RSS 优先、HTML 兜底；单路软降级不报失败，双路全挂才逐路冒泡原因。
 *  ★ 「软降级」只涵盖**这一路没拿到东西**（返回空数组或抛错），不区分原因——
 *    两路各自抛「形状不符」时，冒泡上来的就是那句可定位的话（B-019 的诉求）。 */
export async function bingSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const failed: string[] = [];
  for (const [name, run] of [
    ['rss', bingRss],
    ['html', bingHtml],
  ] as const) {
    try {
      const results = await run(query, signal);
      if (results.length > 0) return results;
      failed.push(`${name}: 空结果`);
    } catch (err) {
      failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(failed.join('; ') || '无结果');
}
