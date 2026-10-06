/** 应试正文读取共用件：现有安全直读失败时，免费浏览器渲染补读。 */
import { getProviderKey } from './index.js';
import { combineSignals } from './combine.js';
import { fetchPageText, publicReason } from './page-text.js';
import type { PageText, PageTextFail } from './page-text.js';
import { tinyfishPage } from './tinyfish.js';

export async function fetchExamPage(
  url: string, ownerId: string | null,
  opts: { signal?: AbortSignal; timeoutMs?: number; allowHosts?: readonly string[] } = {},
): Promise<PageText | PageTextFail> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const signal = combineSignals(opts.signal, timeoutMs);
  const key = getProviderKey('tinyfish', ownerId);
  // 直读超时也能补读；不能让第一次请求耗尽整页预算。
  const directMs = key ? Math.min(3000, Math.max(1, Math.floor(timeoutMs / 2))) : timeoutMs;
  const page = await fetchPageText(url, { ...opts, timeoutMs: directMs, signal: combineSignals(signal, directMs) });
  const needsRender = page.ok ? page.text.length < 500 || /^(?:滑动|安全|访问)验证/.test(page.title)
    : page.kind === 'empty' || (page.kind === 'fetch' && /HTTP (?:403|412|429|5\d\d)\b|timeout|timed out|fetch failed|ECONNRESET/i.test(page.reason));
  if (!needsRender || signal.aborted) return page;
  if (!key) return page;
  try { return await tinyfishPage(url, key, { ...opts, signal }); }
  catch (err) { return { ok: false, kind: 'fetch', reason: publicReason(err) }; }
}
