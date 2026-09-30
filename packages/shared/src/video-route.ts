/**
 * video-route —— 资料溯源的「视频线路」契约（docs/SOURCE-TRACE-SPEC.md §12）。
 *
 * 为什么是一条**单独的线路**而不是塞进 `search_web`：AI 联网搜到的是网页；学习者常常更想要一段十来分钟的
 * 讲解视频，而通用搜索引擎对 B站 / 抖音的收录都很差（抖音几乎不收）。所以这条线路**不经过 AI**：
 * 学习者在资料架上点一下，服务端直接去 B站站内搜（有公开的站内搜索接口，官方播放器可嵌 ⇒ 就地播）；
 * 抖音没有公开接口、也不许嵌播 ⇒ 只能给「站内搜索跳转卡」+ 联网 `site:douyin.com` 命中的跳转卡。
 * 两家的差别（站内播 / 只能跳转）**如实**写在契约与卡面上，不假装一样。
 *
 * 这里只放两端共用的形状与纯函数（查询词清洗、网址识别、播放量格式），取数在服务端 `sources/video-route.ts`。
 * 2026-09-30 首版。
 */
export type VideoRoute = 'bilibili' | 'douyin';

export const VIDEO_ROUTES: readonly VideoRoute[] = ['bilibili', 'douyin'];

export const VIDEO_ROUTE_META: Record<VideoRoute, { label: string; site: string; playable: boolean; hint: string }> = {
  bilibili: { label: 'B站', site: 'bilibili.com', playable: true, hint: 'B站站内搜索，官方播放器就地播' },
  douyin: { label: '抖音', site: 'douyin.com', playable: false, hint: '抖音不开放接口、不许嵌播：只能给标题 + 跳转卡' },
};

/** 查询词上限（服务端同样截断；再长的多半是整段正文，不是知识点） */
export const VIDEO_QUERY_MAX = 80;
/** 一次最多回几条（面板一屏放得下、每条都值得点） */
export const VIDEO_HITS_MAX = 8;
/** 从回答正文推导的默认查询词上限（一个知识点的长度） */
export const VIDEO_SEED_MAX = 30;

export interface VideoHit {
  route: VideoRoute;
  /** 视频页地址（B站是 `/video/BVxxxx`，抖音是 `/video/<id>` 或短链） */
  url: string;
  title: string;
  author?: string;
  /** 封面（B站给；抖音封面带签名会过期，不给） */
  cover?: string;
  /** `mm:ss` / `h:mm:ss` */
  duration?: string;
  plays?: number;
  snippet?: string;
}

export interface VideoRouteResult {
  route: VideoRoute;
  query: string;
  hits: VideoHit[];
  /** 站内搜索页地址：**永远给**（零命中时它就是唯一出口） */
  siteSearchUrl: string;
  /** 命中怎么来的：站内接口 / 联网搜索 / 没有 */
  via: 'api' | 'web' | 'none';
  /** 如实的说明（接口没应答改走联网、抖音只能跳转、零命中的原因……） */
  note?: string;
}

/** 站内搜索页：B站全站搜；抖音的搜索页带 `type=video` 直接落到视频页签 */
export function videoSiteSearchUrl(route: VideoRoute, query: string): string {
  const q = encodeURIComponent(query);
  return route === 'bilibili' ? `https://search.bilibili.com/all?keyword=${q}` : `https://www.douyin.com/search/${q}?type=video`;
}

/** 查询词清洗：去控制字符（按码点判，同 `npc.ts` 的理由：不踩 `no-control-regex`）、并空白、截到上限；空串表示没法搜 */
export function cleanVideoQuery(raw: string): string {
  let kept = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    kept += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return kept.replace(/\s+/g, ' ').trim().slice(0, VIDEO_QUERY_MAX).trim();
}

/**
 * 从一条回答的正文推一个**默认**查询词（学习者随时可改）：优先第一个标题，其次第一行；
 * 剥掉 Markdown 记号 / `[n]` 引用 / 链接文字之外的部分，在第一个句读处截断，再截到 `VIDEO_SEED_MAX`。
 * 推不出（不足 2 个字）就给空串，由面板显示占位提示——宁可空着也不塞一句没法搜的话。
 */
export function videoQueryFromText(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  const pick = heading ?? lines.find((l) => !/^(?:[-*+]\s|\d+[.)]\s|>|```|\|)/.test(l)) ?? lines[0] ?? '';
  const plain = pick
    .replace(/^#{1,6}\s+/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/[*_`~>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const head = plain.split(/[。！？!?；;：:，,、（(]/)[0] ?? '';
  const seed = cleanVideoQuery(head).slice(0, VIDEO_SEED_MAX).trim();
  return [...seed].length >= 2 ? seed : '';
}

/** B站搜索接口把命中词包成 `<em class="keyword">…</em>`：剥标签、还原实体 */
export function stripSearchEm(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BV = /^BV[0-9A-Za-z]{10}$/;

export function bilibiliVideoUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`;
}

/** 从任意 B站视频地址取 BV 号（`www.` / `m.` / `b23.tv` 均可）；不是视频页 ⇒ null */
export function bvidFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(?:www|m)\./, '');
    if (host !== 'bilibili.com' && host !== 'b23.tv') return null;
    const bv = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/)?.[1] ?? '';
    return BV.test(bv) ? bv : null;
  } catch {
    return null;
  }
}

/** 抖音**视频页**识别：`douyin.com/video/<数字 id>` 或 `v.douyin.com/<短码>`；用户主页 / 搜索页 / 话题页 ⇒ null */
export function douyinVideoIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'v.douyin.com') {
      const code = u.pathname.replace(/^\/+|\/+$/g, '');
      return /^[A-Za-z0-9_-]{4,20}$/.test(code) ? code : null;
    }
    if (host !== 'douyin.com' && !host.endsWith('.douyin.com')) return null;
    return u.pathname.match(/\/video\/(\d{6,})/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 播放量：万以下原数，万级一位小数（`67.5万`），十万起整数万，亿级一位小数 */
export function formatPlays(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 10_000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}万`;
  if (n < 100_000_000) return `${Math.round(n / 10_000)}万`;
  return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')}亿`;
}
