/**
 * routes/sources —— 资料溯源的只读端点（契约 docs/SOURCE-TRACE-SPEC.md §6）。
 *
 *  GET /api/sources/view?session=&url=   阅读页（服务端取回 + 白名单清洗的零脚本 HTML，CSP sandbox）
 *  GET /api/sources/pdf?session=&url=    PDF 转发（只放行魔数 `%PDF-` 的响应；面板 iframe 直接显示）
 *  GET /api/sources/session/:id          该会话每条回答挂的资料（历史重开时「资料 n 条」用）
 *  GET /api/sources/probe?session=&url=  阅读页探测（2026-09-30，§13.1）：这页阅读模式打不打得开 / 正文是否太薄 / 服务器能不能截图
 *  GET /api/sources/shot?session=&url=   截图保底（§13）：系统 Chromium 截首屏 PNG；没装浏览器 ⇒ 404 如实说
 *  GET /api/sources/videos?route=&q=     视频线路（§12）：B站站内搜 / 抖音联网搜，不挂会话（是学习者自己点的，不是 AI 引用的资料）
 *  GET /api/sources/read?session=&url=   阅读页的**块模型** JSON（2026-10-04，§14.1）：前端用 React 渲染进主文档，于是选区可读
 *  POST /api/sources/follow              页内跳转许可（§14.2）：用户在确认条上点了「在侧栏打开」才登记，随后 read/view 才认这个网址
 *
 * ★ 许可模型：这不是「任意网址代理」。`view`/`pdf` 都要求 `url` **在这个会话的资料架上**
 *   ——在线架（本轮进行中，`liveShelfKnows`）或已落库（`sourceKnownInSession`）二者之一，
 *   且会话归属当前用户（`canAccessSession`，不归属一律 404 不泄露存在性）。
 *   架上的网址都是搜索引擎给的 / 模型在搜索结果里点的，SSRF 守卫在取页时仍逐跳复检。
 *   2026-10-04 起多一条来源：**用户在跳转确认条上亲自点过**的网址（`isFollowApproved`，§14.2）——
 *   它仍不是开放代理，因为每一条都对应一次明确的人类确认，且同一用户本来就能用 `POST /api/doc/url`
 *   让服务端抓任意网址，follow 没有抬高能力等级，只是把它收进「先看见、再确认」的流程。
 *
 * ★ 阅读页与演示面板同一套沙箱思路（routes/preview.ts）但更严：`sandbox` 不给 allow-scripts
 *   （阅读页零脚本），`default-src 'none'` 只开图片与内联样式——清洗层漏什么，沙箱也兜得住。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../storage/db.js';
import { ownerIdOf, canAccessSession } from '../auth/ownership.js';
import { liveShelfKnows, normalizeSourceUrl } from '../sources/shelf.js';
import { loadSessionSources, sourceKnownInSession } from '../sources/store.js';
import { loadReaderDoc, READER_TIMEOUT_MS } from '../sources/reader.js';
import { loadReaderPage } from '../sources/reader-page.js';
import { approveFollow, isFollowApproved, FOLLOW_MAX_PER_SESSION } from '../sources/follow.js';
import { ShotError, shotAvailable, takeScreenshot } from '../sources/shot.js';
import { searchVideoRoute } from '../sources/video-route.js';
import { VIDEO_ROUTES, cleanVideoQuery, detectSourceKind, siteOf, type VideoRoute } from '@sb/shared';
import { fetchSafe } from '../search/ssrf-guard.js';
import { combineSignals } from '../search/combine.js';
import { FETCH_UA } from '../media/image-download.js';

export const sourcesRouter = Router();

const PDF_MAX_BYTES = 25 * 1024 * 1024;
/** 零脚本沙箱：只开弹窗（阅读页里的「原网页 ↗」与正文链接要能在新标签页打开）、图片与内联样式 */
const READER_CSP =
  "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** 许可：会话归属 + 网址在架上。不通过时给出应回的状态码（404 不泄露会话存在性，403 是「不在架上」） */
function authorize(req: Request): { ok: true; url: string } | { ok: false; status: number; error: string } {
  const sessionId = String(req.query.session ?? '');
  const raw = String(req.query.url ?? '');
  if (!sessionId || !raw) return { ok: false, status: 400, error: '缺 session 或 url' };
  if (!canAccessSession(sessionId, ownerIdOf(req))) return { ok: false, status: 404, error: '会话不存在' };
  const url = normalizeSourceUrl(raw);
  if (!/^https?:\/\//i.test(url)) return { ok: false, status: 400, error: '只支持 http(s) 网址' };
  // 三条来源任一即可：在线架 / 已落库 / 用户在跳转确认条上亲自放行过（§14.2）
  if (!liveShelfKnows(sessionId, url) && !sourceKnownInSession(getDb(), sessionId, url) && !isFollowApproved(sessionId, url)) {
    return { ok: false, status: 403, error: '这个网址不在本会话的资料架上' };
  }
  return { ok: true, url };
}

/**
 * 失败页：同样走沙箱文档（面板 iframe 里能读到原因，不是浏览器的灰色错误页）。
 * 有截图能力时面板会自己换成截图视图（`/probe` 告诉它的），这页只是一闪而过；没有时它就是终点，所以把「为什么没有截图」也说清。
 */
function failDoc(reason: string, url: string, canShot: boolean): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const shotLine = canShot ? '<p>面板正在改用服务器截图…</p>' : '<p>服务器没装浏览器，截不了图。</p>';
  return (
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>body{margin:0;background:#140d12;color:#ecdfcc;` +
    `font:14px/1.7 system-ui,sans-serif;padding:32px;text-align:center}a{color:#ffd27a}</style></head><body>` +
    `<p>阅读模式没打开这一页：${esc(reason)}</p>${shotLine}<p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">在新标签页打开原网页 ↗</a></p></body></html>`
  );
}

sourcesRouter.get('/view', async (req: Request, res: Response) => {
  const auth = authorize(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const title = String(req.query.title ?? '').slice(0, 200);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const loaded = await loadReaderDoc(auth.url, title, ac.signal);
  res.setHeader('Content-Security-Policy', READER_CSP);
  // 全局安全头是 X-Frame-Options: DENY（会把本应用的资料架一起挡掉）；阅读页与演示页同理只对同源开放
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.type('html');
  if (!loaded.ok) {
    res.status(loaded.status).send(failDoc(loaded.reason, auth.url, shotAvailable()));
    return;
  }
  res.send(loaded.html);
});

/**
 * 阅读页的块模型（§14.1）。与 `/view` 的区别只在**出口形态**：那边是沙箱 iframe 里的 HTML 文档，
 * 这边是 JSON 结构，交给前端用 React 渲染进主文档 —— 于是选区可读（划线功能的前提）。
 * 取页、清洗、缓存三件事两条路完全共用，不会出现「iframe 看到的和划线取到的不是同一份」。
 */
sourcesRouter.get('/read', async (req: Request, res: Response) => {
  const auth = authorize(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const title = String(req.query.title ?? '').slice(0, 200);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const page = await loadReaderPage(auth.url, title, ac.signal);
  res.setHeader('Cache-Control', 'private, max-age=600');
  // 失败也回 200 + ok:false：面板要把原因显示在阅读区里，而不是吞成一个网络错误（ADR-5）
  res.json(page);
});

/**
 * 页内跳转许可（§14.2）。**只有用户在确认条上点过「在侧栏打开」才会走到这里**，
 * 登记后随后的 `/read`、`/view`、`/probe`、`/shot` 才认这个网址。
 *
 * 这里不抓页、不解析，只记一条许可；真正的 SSRF 防护在取页时由 `fetchSafe` 逐跳负责。
 * 撞上限回 429 并说清怎么办——静默丢弃会让人点了确认却跳不动，还不知道为什么。
 */
sourcesRouter.post('/follow', (req: Request, res: Response) => {
  const body: unknown = req.body;
  const b = (typeof body === 'object' && body !== null ? body : {}) as { session?: unknown; url?: unknown };
  const sessionId = String(b.session ?? '');
  const raw = String(b.url ?? '');
  if (!sessionId || !raw) {
    res.status(400).json({ error: '缺 session 或 url' });
    return;
  }
  if (!canAccessSession(sessionId, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const url = normalizeSourceUrl(raw);
  if (!/^https?:\/\//i.test(url)) {
    res.status(400).json({ error: '只支持 http(s) 网址' });
    return;
  }
  if (!approveFollow(sessionId, url)) {
    res.status(429).json({ error: `这个会话里已经跟进过 ${FOLLOW_MAX_PER_SESSION} 个网址，新开一个会话再继续` });
    return;
  }
  res.json({ ok: true, url, site: siteOf(url) });
});

sourcesRouter.get('/pdf', async (req: Request, res: Response) => {
  const auth = authorize(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    const up = await fetchSafe(auth.url, {
      headers: { 'User-Agent': FETCH_UA, Accept: 'application/pdf,*/*;q=0.5' },
      signal: combineSignals(ac.signal, READER_TIMEOUT_MS * 2),
    });
    if (!up.ok || !up.body) {
      res.status(502).json({ error: `对方返回 HTTP ${up.status}` });
      return;
    }
    const len = Number(up.headers.get('content-length') ?? 0);
    if (len > PDF_MAX_BYTES) {
      res.status(413).json({ error: 'PDF 超过 25MB，请在新标签页打开' });
      return;
    }
    const reader = up.body.getReader();
    const first = await reader.read();
    const head = first.value ?? new Uint8Array();
    // 魔数校验在**字节**上做（与 fetch_page 的二进制嗅探同理由）：content-type 可以谎报，前 5 字节不会
    if (head.length < 5 || String.fromCharCode(...head.subarray(0, 5)) !== '%PDF-') {
      await reader.cancel().catch(() => undefined);
      res.status(415).json({ error: '这个地址返回的不是 PDF' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=600');
    let sent = head.length;
    res.write(Buffer.from(head));
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      sent += value.length;
      if (sent > PDF_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: /abort/i.test(msg) ? '读取超时' : '取不到这个 PDF' });
  }
});

/**
 * 阅读页探测：面板在挂 iframe 的同时问一句「这页会不会打不开 / 是不是太薄 / 能不能截图」，据此决定要不要换成截图视图。
 * 图片类资料永远 ok（阅读页只是套壳显示原图）。与 `/view` 合流同一次取页（reader 的 inflight），不多拉上游。
 */
sourcesRouter.get('/probe', async (req: Request, res: Response) => {
  const auth = authorize(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  const shot = shotAvailable();
  if (detectSourceKind(auth.url) === 'image') {
    res.json({ ok: true, thin: false, shot });
    return;
  }
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  const loaded = await loadReaderDoc(auth.url, String(req.query.title ?? '').slice(0, 200), ac.signal);
  res.setHeader('Cache-Control', 'private, max-age=600');
  if (loaded.ok) res.json({ ok: true, thin: loaded.thin, shot });
  else res.json({ ok: false, status: loaded.status, reason: loaded.reason, thin: false, shot });
});

const SHOT_STATUS: Record<ShotError['kind'], number> = { no_browser: 404, blocked: 400, timeout: 504, busy: 503, failed: 502 };

/** 截图保底：许可模型与 `/view` 完全相同（只服务架上的网址）；PNG 直出，错误一律 JSON 且状态码按失败种类 */
sourcesRouter.get('/shot', async (req: Request, res: Response) => {
  const auth = authorize(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }
  try {
    const png = await takeScreenshot(auth.url);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(png);
  } catch (err) {
    if (err instanceof ShotError) {
      res.status(SHOT_STATUS[err.kind]).json({ error: err.message, kind: err.kind });
      return;
    }
    res.status(502).json({ error: '浏览器没截成这一页', kind: 'failed' });
  }
});

/** 视频线路：`route` 只认两家，`q` 清洗后非空且 ≤80；失败形态都在结果体里（`via:'none'` + `note`），这里只挡坏参数 */
sourcesRouter.get('/videos', async (req: Request, res: Response) => {
  const route = String(req.query.route ?? '') as VideoRoute;
  const q = cleanVideoQuery(String(req.query.q ?? ''));
  if (!VIDEO_ROUTES.includes(route)) {
    res.status(400).json({ error: '线路只有 bilibili / douyin' });
    return;
  }
  if (!q) {
    res.status(400).json({ error: '缺查询词' });
    return;
  }
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  res.json(await searchVideoRoute(route, q, ownerIdOf(req), ac.signal));
});

sourcesRouter.get('/session/:id', (req: Request, res: Response) => {
  const id = req.params.id ?? '';
  if (!canAccessSession(id, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ byMessage: loadSessionSources(getDb(), id) });
});
