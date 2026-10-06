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
  const signal = combineSignals(opts.signal, opts.timeoutMs ?? 15_000);
  const page = await fetchPageText(url, { ...opts, signal });
  const needsRender = page.ok ? page.text.length < 500 || /^(?:滑动|安全|访问)验证/.test(page.title)
    : page.kind === 'empty' || (page.kind === 'fetch' && /HTTP (?:403|429|503)/.test(page.reason));
  if (!needsRender || signal.aborted) return page;
  const key = getProviderKey('tinyfish', ownerId);
  if (!key) return page;
  try { return await tinyfishPage(url, key, { ...opts, signal }); }
  catch (err) { return { ok: false, kind: 'fetch', reason: publicReason(err) }; }
}
