/**
 * learning/doc-url —— 网页资料：**一个网址 → 本会话的学习资料**（契约 `docs/DOC-RAG-SPEC.md` §10）。
 *
 * 起因：学习者手上常常已经有「就看这一页」的网址（课程讲义页、百科条目、某篇规范），
 * 而今天要把它变成资料只有一条路——自己打开、全选、复制、粘进面板。而仓里**两半零件早就都有**：
 * `search/page-text.ts` 能把网址变成干净正文，`learning/document.ts` 能把正文变成会话资料
 * （短文直塞 / 长文 BM25 检索）。本件就是中间那根管子，不新造检索、不新造存储、不加迁移。
 *
 * 与资料溯源（`docs/SOURCE-TRACE-SPEC.md`）的分工**必须说清，这是两件事**：
 * · 资料架是 **AI 这一轮读了什么**——编号即身份、随消息落库、回答收口就定格；
 * · 网页资料是 **学习者指定「以后都按这一页答」**——会话级、每次一份、跨轮持续生效，
 *   并且出题（`routes/quiz.ts`）与抽词条（`routes/terms.ts`）两条回退链都吃它。
 * 同一个网址可以既在架上又是资料，但语义不同，所以不复用 `message_source` 表。
 *
 * 安全：抓取全程走 `fetchPageText`（内含 `fetchSafe` 的 SSRF 逐跳复检 + 三道内容闸）。
 * 正文进模型上下文时仍是「数据不是指令」——护栏由 `document.ts` 的 `DOC_GUARD` 统一加，
 * 本件**不另造一套**（两套防注入声明必然漂）。
 */
import { DOC_URL_MAX_CHARS } from '@sb/shared';
import { siteOf } from '@sb/shared';
import { fetchPageText } from '../search/page-text.js';

/** 网址长度上限：与 `fetch_page` 同值（超长 URL 多半是拼接事故，不是真地址） */
const MAX_URL_CHARS = 2000;

export interface UrlDocDraft {
  /** 入库用的资料名：网页标题，取不到退回站名 */
  name: string;
  /** 入库用的正文：溯源抬头 + 网页正文（+ 截断说明） */
  text: string;
  /** 规整后的网址（回执里给前端，便于显示「这份资料来自哪」） */
  url: string;
  title: string;
  site: string;
  /** 原始正文字数（**截断前**）——截了多少要说得出来 */
  sourceChars: number;
  /** 是否因超 `DOC_URL_MAX_CHARS` 被截 */
  clipped: boolean;
}

/** 失败一律带 HTTP 状态码返回，路由只管转发（ADR-4：不抛异常当控制流） */
export interface UrlDocError {
  ok: false;
  status: number;
  error: string;
}

/**
 * 溯源抬头：**存进正文里**，不加库列。
 *
 * 为什么不加一列 `doc_url`：那要占一个迁移版本号，而这几行信息唯一的消费者就是模型——
 * 它需要知道「这份资料是一张网页快照、来自哪、什么时候抓的」，才答得出「这页没写」
 * 而不是「这件事不存在」，也才不会把半年前的快照当现状。写进正文零迁移、
 * 翻历史会话时也还在，代价只是占掉抬头那几十个字。
 */
function provenanceHead(url: string, title: string, site: string): string {
  return [
    '【资料来源：网页快照】',
    `网址：${url}`,
    `标题：${title || '（该页未给标题）'}`,
    `站点：${site}`,
    `抓取日期：${new Date().toISOString().slice(0, 10)}`,
    '说明：以下正文是上述网页在抓取当天的文字快照，不含图片与脚本渲染的内容；',
    '网页此后可能已改动。资料里没写的，只说明这张快照里没有，不等于该网页或现实中不存在。',
    '',
  ].join('\n');
}

/**
 * 抓一个网址，组装成可直接交给 `setSessionDoc` 的资料草稿。
 *
 * 三类失败各给**自己的状态码**（都是人看得懂的一句话，不是堆栈）：
 * · 400 网址本身不对（空 / 非 http(s)）——还没出门就能判；
 * · 415 取回来了但不是网页（PDF / 图片 / 二进制）——告诉他「它是什么」，好改道；
 * · 422 是网页但剥不出正文（纯脚本渲染页）——这类**换个办法也抓不到**，得说清；
 * · 502 没取回来（对方 404/超时/拒绝，或被 SSRF 守卫拦下）。
 * ★ SSRF 拦截的原因已被 `publicReason` 收敛成「该地址不被允许访问」，
 *   内网地址与端口**不出现在响应里**——接口响应同样是探测面，口径与工具侧一致。
 */
export async function fetchDocFromUrl(
  rawUrl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: true; draft: UrlDocDraft } | UrlDocError> {
  const url = String(rawUrl ?? '').trim().slice(0, MAX_URL_CHARS);
  if (!url) return { ok: false, status: 400, error: '网址不能为空' };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, status: 400, error: '只支持 http/https 网址（要带 https:// 开头）' };
  }

  const page = await fetchPageText(url, { signal: opts.signal });
  if (!page.ok) {
    if (page.kind === 'not_page') {
      return { ok: false, status: 415, error: `这个地址不是网页（${page.what}），载入资料只支持网页正文` };
    }
    if (page.kind === 'empty') {
      return {
        ok: false,
        status: 422,
        error: '这一页打开了，但没抓到正文（多半是靠脚本渲染的页面）。可以把正文复制下来用「粘贴」载入',
      };
    }
    return { ok: false, status: 502, error: `这一页没读到（${page.reason}）` };
  }

  const site = siteOf(url);
  const title = page.title.trim();
  const sourceChars = page.text.length;
  const clipped = sourceChars > DOC_URL_MAX_CHARS;
  const body = clipped ? page.text.slice(0, DOC_URL_MAX_CHARS) : page.text;
  const tail = clipped
    ? `\n\n（该页正文共 ${sourceChars} 字，超出单份资料上限，已截取前 ${DOC_URL_MAX_CHARS} 字；后面的内容不在这份资料里。）`
    : '';

  return {
    ok: true,
    draft: {
      // 名字只用标题、**不拼站名**：pill 宽度有限，拼上去会把标题挤没；站名在抬头里有
      name: (title || site).slice(0, 200),
      text: `${provenanceHead(url, title, site)}${body}${tail}`,
      url,
      title,
      site,
      sourceChars,
      clipped,
    },
  };
}
